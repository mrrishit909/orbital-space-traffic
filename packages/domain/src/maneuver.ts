// Avoidance-maneuver planning. A burn's effect is propagated numerically (two-body + J2, RK4) as the difference between the
// burned and un-burned states, then added to the SGP4 trajectory; the closest approach and Pc are recomputed on that path.
// The search is a grid over burn lead time with bisection on the burn size at each lead time (Pc falls monotonically with an
// in-track burn of growing size, so bisection finds the smallest burn that reaches the target).
import type { SatRec } from "satellite.js";
import { J2, MU, RE, add, brentMin, dot, mat, norm, ricBasis, scale, sub, type V3 } from "./math.ts";
import { stateAt } from "./tle.ts";
import { encounterPlane, pc2d } from "./pc.ts";

type S6 = [number, number, number, number, number, number];

function accel(r: V3): V3 {
  const x = r[0], y = r[1], z = r[2];
  const r2 = x * x + y * y + z * z, rr = Math.sqrt(r2), r3 = r2 * rr;
  const k = (1.5 * J2 * MU * RE * RE) / (r2 * r2 * rr), zz = (5 * z * z) / r2;
  return [-MU * x / r3 + k * x * (zz - 1), -MU * y / r3 + k * y * (zz - 1), -MU * z / r3 + k * z * (zz - 3)];
}
function deriv(s: S6): S6 {
  const a = accel([s[0], s[1], s[2]]);
  return [s[3], s[4], s[5], a[0], a[1], a[2]];
}
export function rk4(s: S6, dt: number): S6 {
  const k1 = deriv(s);
  const k2 = deriv(s.map((x, i) => x + 0.5 * dt * k1[i]) as S6);
  const k3 = deriv(s.map((x, i) => x + 0.5 * dt * k2[i]) as S6);
  const k4 = deriv(s.map((x, i) => x + dt * k3[i]) as S6);
  return s.map((x, i) => x + (dt / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i])) as S6;
}

/** Displacement (km) of the burned trajectory relative to the un-burned one, sampled every stepSec from the burn to tEnd. */
export function burnOffsets(sat: SatRec, burn: Date, dvRicMs: V3, tEnd: Date, stepSec = 10) {
  const st = stateAt(sat, burn);
  if (!st) throw new Error("primary cannot be propagated at burn time");
  const B = ricBasis(st.r, st.v);
  const dv = mat.vec(mat.t(B), scale(dvRicMs, 1 / 1000)); // RIC m/s -> inertial km/s
  let a: S6 = [...st.r, ...st.v] as S6;
  let b: S6 = [...st.r, ...add(st.v, dv)] as S6;
  const n = Math.ceil((tEnd.getTime() - burn.getTime()) / 1000 / stepSec);
  const off = new Float64Array((n + 1) * 3);
  for (let i = 1; i <= n; i++) {
    a = rk4(a, stepSec); b = rk4(b, stepSec);
    off[i * 3] = b[0] - a[0]; off[i * 3 + 1] = b[1] - a[1]; off[i * 3 + 2] = b[2] - a[2];
  }
  const t0 = burn.getTime();
  return (t: Date): V3 => {
    const x = (t.getTime() - t0) / 1000 / stepSec;
    if (x <= 0) return [0, 0, 0];
    const i = Math.min(Math.floor(x), n - 1), f = Math.min(1, x - i);
    return [off[i * 3] * (1 - f) + off[i * 3 + 3] * f, off[i * 3 + 1] * (1 - f) + off[i * 3 + 4] * f, off[i * 3 + 2] * (1 - f) + off[i * 3 + 5] * f];
  };
}

export interface ConjunctionInput {
  primary: SatRec;
  secondary: SatRec;
  tca: Date;
  /** combined position covariance at TCA, inertial, km^2 */
  cov: import("./math.ts").M3;
  hbrKm: number;
}

export interface ManeuverResult {
  leadOrbits: number;
  burn: Date;
  dvRicMs: V3;
  dvMs: number;
  tca: Date;
  missKm: number;
  pc: number;
}

/** Closest approach and Pc after a burn. */
export function evaluateBurn(c: ConjunctionInput, burn: Date, dvRicMs: V3): ManeuverResult & { leadOrbits: number } {
  const end = new Date(c.tca.getTime() + 600e3);
  const off = burnOffsets(c.primary, burn, dvRicMs, end);
  const base = c.tca.getTime();
  const pathAt = (dt: number) => {
    const t = new Date(base + dt * 1000);
    const p = stateAt(c.primary, t)!, s = stateAt(c.secondary, t)!;
    return { p: add(p.r, off(t)), pv: p.v, s: s.r, sv: s.v };
  };
  const m = brentMin((dt) => { const q = pathAt(dt); return norm(sub(q.p, q.s)); }, -300, 300, 1e-10, 200);
  const q = pathAt(m.x);
  const plane = encounterPlane(q.p, q.pv, q.s, q.sv, c.cov);
  const period = (2 * Math.PI) / (c.primary.no / 60);
  return { leadOrbits: (c.tca.getTime() - burn.getTime()) / 1000 / period, burn, dvRicMs, dvMs: norm(dvRicMs), tca: new Date(base + m.x * 1000), missKm: m.fx, pc: pc2d(plane.missKm, plane.cov, c.hbrKm) };
}

export interface PlanOptions { targetPc?: number; leadOrbits?: number[]; maxDvMs?: number; notBefore?: Date; /** keep both burn directions per lead time (for re-screening) */ bothSigns?: boolean }

/**
 * For each lead time, the smallest in-track burn (prograde or retrograde, whichever helps) that brings Pc to the target.
 * Returns the frontier; the UI offers the cheapest option and the latest one that still works.
 */
export function planManeuvers(c: ConjunctionInput, o: PlanOptions = {}): ManeuverResult[] {
  const target = o.targetPc ?? 1e-6, maxDv = o.maxDvMs ?? 2;
  const period = (2 * Math.PI) / (c.primary.no / 60); // seconds
  const leads = o.leadOrbits ?? [0.25, 0.5, 1, 1.5, 2, 3, 4, 6];
  const out: ManeuverResult[] = [];
  for (const L of leads) {
    const burn = new Date(c.tca.getTime() - L * period * 1000);
    if (o.notBefore && burn < o.notBefore) continue;
    const found: ManeuverResult[] = [];
    for (const sign of [1, -1]) {
      const at = (dv: number) => evaluateBurn(c, burn, [0, sign * dv, 0]);
      if (at(maxDv).pc > target) continue;
      let lo = 0, hi = maxDv;
      for (let i = 0; i < 22; i++) { const mid = (lo + hi) / 2; if (at(mid).pc > target) lo = mid; else hi = mid; }
      found.push({ ...at(hi), leadOrbits: L });
    }
    found.sort((a, b) => a.dvMs - b.dvMs);
    out.push(...(o.bothSigns ? found : found.slice(0, 1)));
  }
  return out;
}

/** Pick the two options the UI compares: cheapest burn, and the latest burn time that still reaches the target. */
export function twoOptions(frontier: ManeuverResult[]): [ManeuverResult, ManeuverResult] | null {
  if (frontier.length === 0) return null;
  const cheapest = frontier.reduce((a, b) => (b.dvMs < a.dvMs ? b : a));
  const latest = frontier.reduce((a, b) => (b.leadOrbits < a.leadOrbits ? b : a));
  return [cheapest, latest === cheapest ? frontier.find((f) => f !== cheapest) ?? latest : latest];
}

/** Path of the primary after a burn (SGP4 + numerically propagated offset), for drawing and for re-screening. */
export function burnedPath(sat: SatRec, burn: Date, dvRicMs: V3, tEnd: Date) {
  const off = burnOffsets(sat, burn, dvRicMs, tEnd, 20);
  return (t: Date): V3 | null => { const s = stateAt(sat, t); return s ? add(s.r, off(t)) : null; };
}

export const _test = { accel, dot };
