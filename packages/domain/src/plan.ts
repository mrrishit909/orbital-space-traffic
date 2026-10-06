// Avoidance planning with re-screening: a burn that clears one conjunction can create another (often a later pass of the same
// object), so every candidate burn's new orbit is screened against the catalog before it is offered.
import type { SatRec } from "satellite.js";
import { brentMin, mat, type V3 } from "./math.ts";
import { stateAt } from "./tle.ts";
import { screenPath, shellOf, shellsOverlap, type BatchPropagator } from "./screen.ts";
import { burnedPath, planManeuvers, type ManeuverResult } from "./maneuver.ts";
import { covEci, encounterPlane, pc2d, sigmaAt } from "./pc.ts";
import type { Conjunction } from "./conjunctions.ts";

export const TARGET_PC = 1e-6;
/** Re-screening volume: 5 km plus how far a few cm/s can move the satellite in a day. Checked per option; full screen otherwise. */
export const NEAR_KM = 60;
const ISP_S = 220; // hydrazine monopropellant, typical for small LEO satellites
export const propellantKg = (dvMs: number, massKg: number) => massKg * (1 - Math.exp(-dvMs / (ISP_S * 9.80665)));

export interface NewApproach { secondaryNorad: number; tca: string; missM: number; pc: number }
export interface PlanOption extends Omit<ManeuverResult, "burn" | "tca"> {
  burn: string; tca: string; propellantKg: number; newApproaches: NewApproach[]; planeXYm: [number, number];
  safe: boolean; worst: NewApproach | null; rescreen: "near-list" | "full";
}
export interface PlanInput {
  sats: SatRec[];
  meta: { radiusM: number; sigma: [number, number, number] }[]; // per catalog object (sats may hold extra stress-test objects after these)
  norads: number[];
  epoch: number;
  conjunction: Conjunction;
  notBefore: Date;
  massKg: number;
  batch?: BatchPropagator;
  onProgress?: (stage: string, fraction: number) => void;
  /** force the full re-screen for every candidate (equivalence test) */
  fullRescreen?: boolean;
}
export interface PlanResult { options: PlanOption[]; rejected: PlanOption[]; frontier: number }

export function planWithRescreen(o: PlanInput): PlanResult {
  const { sats, meta, norads, epoch, batch, conjunction: c } = o;
  const pi = norads.indexOf(c.primaryNorad), si = norads.indexOf(c.secondaryNorad);
  if (pi < 0 || si < 0) throw new Error("conjunction objects are not in the catalog");
  const input = { primary: sats[pi], secondary: sats[si], tca: new Date(c.tca), cov: c.covKm2, hbrKm: c.hbrM / 1000 };
  o.onProgress?.("Searching burn times, directions and sizes", 0.05);
  const frontier = planManeuvers(input, { notBefore: o.notBefore, bothSigns: true });
  const end = new Date(epoch + 24 * 3600e3);
  const shell = shellOf(sats[pi]);
  const cands = meta.map((_, j) => j).filter((j) => j !== pi && shellsOverlap(shell, shellOf(sats[j]), 30));
  const basis = encounterPlane(c.rPrimary, c.vPrimary, c.rSecondary, c.vSecondary, c.covKm2).basis;
  o.onProgress?.(`Screening the nominal orbit against ${cands.length.toLocaleString("en-US")} objects with a ${NEAR_KM} km volume`, 0.08);
  const near = screenPath({ path: (t) => stateAt(sats[pi], t)?.r ?? null, sats, candidates: cands, start: o.notBefore, end, thresholdKm: NEAR_KM, batch });
  const dist = (path: (t: Date) => V3 | null, j: number, t: number) => {
    const p = path(new Date(t)), q = stateAt(sats[j], new Date(t));
    return p && q ? Math.hypot(p[0] - q.r[0], p[1] - q.r[1], p[2] - q.r[2]) : Infinity;
  };

  const checked = new Map<ManeuverResult, PlanOption>();
  const check = (mv: ManeuverResult, k: number, of: number): PlanOption => {
    const hit = checked.get(mv);
    if (hit) return hit;
    o.onProgress?.(`Re-screening candidate ${k} of up to ${of} (${mv.leadOrbits} orbits early, ${(mv.dvMs * 100).toFixed(2)} cm/s) against ${near.length} nearby passes`, Math.min(0.95, 0.1 + (0.85 * k) / of));
    const path = burnedPath(sats[pi], mv.burn, mv.dvRicMs, end);
    // the burned orbit stays within maxDev of the nominal one, so only pairs that came within 5 km + maxDev can now be under 5 km
    let maxDev = 0;
    for (let t = mv.burn.getTime(); t <= end.getTime(); t += 600e3) {
      const a = path(new Date(t)), b = stateAt(sats[pi], new Date(t));
      if (a && b) maxDev = Math.max(maxDev, Math.hypot(a[0] - b.r[0], a[1] - b.r[1], a[2] - b.r[2]));
    }
    const fast = !o.fullRescreen && maxDev < NEAR_KM - 6;
    const found = fast
      ? near.filter((e) => e.tca.getTime() > mv.burn.getTime() - 300e3).flatMap((e) => {
          const base = e.tca.getTime();
          const m = brentMin((dt) => dist(path, e.secondary, base + dt * 1000), -240, 240, 1e-9, 200);
          return m.fx <= 5 ? [{ secondary: e.secondary, tca: new Date(base + m.x * 1000), missKm: m.fx }] : [];
        })
      : screenPath({ path, sats, candidates: cands, start: mv.burn, end, batch });
    const newApproaches: NewApproach[] = found.map((f) => {
      // Pc of each approach on the new path, with both objects' covariances at that time
      const p = path(f.tca)!, ps = stateAt(sats[pi], f.tca)!, ss = stateAt(sats[f.secondary], f.tca)!;
      const h = (f.tca.getTime() - epoch) / 3600e3;
      const C = mat.add(covEci(p, ps.v, sigmaAt(meta[pi].sigma, h, sats[pi].bstar)), covEci(ss.r, ss.v, sigmaAt(meta[f.secondary].sigma, h, sats[f.secondary].bstar)));
      const plane = encounterPlane(p, ps.v, ss.r, ss.v, C);
      return { secondaryNorad: norads[f.secondary], tca: f.tca.toISOString(), missM: Math.round(f.missKm * 1000), pc: pc2d(plane.missKm, plane.cov, (meta[pi].radiusM + meta[f.secondary].radiusM) / 1000) };
    }).filter((a) => !(a.secondaryNorad === c.secondaryNorad && Math.abs(Date.parse(a.tca) - Date.parse(c.tca)) < 600e3)); // the one being avoided
    // where the secondary now passes, in the original encounter plane (metres), for the encounter view
    const pp = path(mv.tca)!, ss = stateAt(sats[si], mv.tca)!;
    const d = [ss.r[0] - pp[0], ss.r[1] - pp[1], ss.r[2] - pp[2]];
    const planeXYm = [basis[0], basis[1]].map((b) => 1000 * (b[0] * d[0] + b[1] * d[1] + b[2] * d[2])) as [number, number];
    const worst = newApproaches.reduce<NewApproach | null>((w, a) => (a.pc > (w?.pc ?? 0) ? a : w), null);
    const r: PlanOption = { ...mv, burn: mv.burn.toISOString(), tca: mv.tca.toISOString(), propellantKg: propellantKg(mv.dvMs, o.massKg), newApproaches, planeXYm,
      safe: !worst || worst.pc <= TARGET_PC, worst, rescreen: fast ? "near-list" : "full" };
    checked.set(mv, r);
    return r;
  };
  // option A: the cheapest burn whose new orbit is clean; option B: the latest burn time whose new orbit is clean
  const byDv = [...frontier].sort((a, b) => a.dvMs - b.dvMs);
  const byLate = [...frontier].sort((a, b) => a.leadOrbits - b.leadOrbits || a.dvMs - b.dvMs);
  let k = 0;
  const A = byDv.find((x) => check(x, ++k, frontier.length).safe);
  const B = byLate.find((x) => x !== A && check(x, ++k, frontier.length).safe);
  const options = [A, B].filter((x): x is ManeuverResult => !!x).map((x) => checked.get(x)!);
  const rejected = [...checked.values()].filter((x) => !x.safe);
  return { options, rejected, frontier: frontier.length };
}
