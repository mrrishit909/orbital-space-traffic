// Conjunction screening: coarse orbital-shell filter, then a time-stepped pass that uses straight-line relative motion around each
// sample to find the sample nearest each close approach, then Brent's method on the real SGP4 distance for TCA and miss.
import type { SatRec } from "satellite.js";
import { RE, MU, brentMin, norm, sub, type V3 } from "./math.ts";
import { stateAt } from "./tle.ts";

export interface Ephemeris {
  /** positions (km) and velocities (km/s), [object][step][xyz] flattened; NaN where SGP4 failed */
  pos: Float64Array;
  vel: Float64Array;
}
/** Propagates objects (by index into the catalog) at the given times. JS and WASM implementations exist. */
export type BatchPropagator = (sats: SatRec[], times: Date[]) => Ephemeris;

export const jsBatch: BatchPropagator = (sats, times) => {
  const n = sats.length * times.length * 3;
  const pos = new Float64Array(n).fill(NaN), vel = new Float64Array(n).fill(NaN);
  sats.forEach((s, i) => times.forEach((t, k) => {
    const st = stateAt(s, t);
    if (!st) return;
    const o = (i * times.length + k) * 3;
    pos.set(st.r, o); vel.set(st.v, o);
  }));
  return { pos, vel };
};

export interface Shell { perigeeKm: number; apogeeKm: number }
export function shellOf(s: SatRec): Shell {
  const nRadS = s.no / 60; // satrec.no is rad/min (Kozai-unrolled mean motion)
  const a = Math.cbrt(MU / (nRadS * nRadS));
  return { perigeeKm: a * (1 - s.ecco) - RE, apogeeKm: a * (1 + s.ecco) - RE };
}
export const shellsOverlap = (a: Shell, b: Shell, padKm: number) => a.perigeeKm - padKm <= b.apogeeKm + padKm && b.perigeeKm - padKm <= a.apogeeKm + padKm;

export interface Encounter {
  primary: number; // index into sats
  secondary: number;
  tca: Date;
  missKm: number;
  relSpeedKms: number;
  rPrimary: V3;
  vPrimary: V3;
  rSecondary: V3;
  vSecondary: V3;
}

export interface ScreenOptions {
  sats: SatRec[];
  primaries: number[];
  start: Date;
  hours: number;
  stepSec?: number;
  thresholdKm?: number;
  shellPadKm?: number;
  batch?: BatchPropagator;
  chunkSteps?: number;
  onProgress?: (fraction: number) => void;
}

export interface ScreenStats { candidatesPerPrimary: number; pairsChecked: number; refined: number; ms: number }

/** Closest approach of two objects near time t0 (search window +-halfWindowSec), on the exact SGP4 trajectories. */
export function refineTca(a: SatRec, b: SatRec, t0: Date, halfWindowSec: number) {
  const base = t0.getTime();
  const f = (dt: number) => {
    const sa = stateAt(a, new Date(base + dt * 1000)), sb = stateAt(b, new Date(base + dt * 1000));
    return sa && sb ? norm(sub(sa.r, sb.r)) : Infinity;
  };
  const m = brentMin(f, -halfWindowSec, halfWindowSec, 1e-9, 200);
  const tca = new Date(base + m.x * 1000);
  const sa = stateAt(a, tca)!, sb = stateAt(b, tca)!;
  return { tca, missKm: m.fx, sa, sb, edge: Math.abs(Math.abs(m.x) - halfWindowSec) < 1e-3 };
}

export function screen(o: ScreenOptions): { encounters: Encounter[]; stats: ScreenStats } {
  const t0 = performance.now();
  const step = o.stepSec ?? 60, thr = o.thresholdKm ?? 5, pad = o.shellPadKm ?? 25, chunk = o.chunkSteps ?? 30;
  const batch = o.batch ?? jsBatch;
  const nSteps = Math.ceil((o.hours * 3600) / step) + 1;
  const shells = o.sats.map(shellOf);
  const primSet = new Set(o.primaries);
  // candidate secondaries per primary (shell overlap), and the union we must propagate
  const cands = o.primaries.map((p) => o.sats.map((_, j) => j).filter((j) => j !== p && shellsOverlap(shells[p], shells[j], pad + thr)));
  const union = [...new Set([...o.primaries, ...cands.flat()])].sort((a, b) => a - b);
  const slot = new Map(union.map((j, k) => [j, k]));
  const unionSats = union.map((j) => o.sats[j]);
  const found = new Map<string, Encounter>();
  let pairs = 0, refined = 0;
  for (let s0 = 0; s0 < nSteps; s0 += chunk) {
    const times = Array.from({ length: Math.min(chunk, nSteps - s0) }, (_, k) => new Date(o.start.getTime() + (s0 + k) * step * 1000));
    const eph = batch(unionSats, times);
    const T = times.length;
    for (let pi = 0; pi < o.primaries.length; pi++) {
      const p = o.primaries[pi], ps = slot.get(p)!;
      for (const j of cands[pi]) {
        if (primSet.has(j) && j < p) continue; // primary-vs-primary pairs once
        const js = slot.get(j)!;
        for (let k = 0; k < T; k++) {
          const a = (ps * T + k) * 3, b = (js * T + k) * 3;
          const dx = eph.pos[b] - eph.pos[a], dy = eph.pos[b + 1] - eph.pos[a + 1], dz = eph.pos[b + 2] - eph.pos[a + 2];
          if (!(Math.abs(dx) < 1000 && Math.abs(dy) < 1000 && Math.abs(dz) < 1000)) continue; // also skips NaN
          pairs++;
          const vx = eph.vel[b] - eph.vel[a], vy = eph.vel[b + 1] - eph.vel[a + 1], vz = eph.vel[b + 2] - eph.vel[a + 2];
          const vv = vx * vx + vy * vy + vz * vz;
          const tau = vv > 0 ? -(dx * vx + dy * vy + dz * vz) / vv : 0;
          if (Math.abs(tau) > step / 2 + 1) continue; // the nearest approach belongs to another sample
          const dl = Math.hypot(dx + tau * vx, dy + tau * vy, dz + tau * vz);
          if (dl > thr + 2) continue; // 2 km margin covers the bend of relative motion over half a step
          const key = `${Math.min(p, j)}:${Math.max(p, j)}:${Math.round((times[k].getTime() + tau * 1000) / 600000)}`;
          if (found.has(key)) continue;
          refined++;
          const r = refineTca(o.sats[p], o.sats[j], new Date(times[k].getTime() + tau * 1000), step);
          if (r.missKm <= thr && !r.edge)
            found.set(key, { primary: p, secondary: j, tca: r.tca, missKm: r.missKm, relSpeedKms: norm(sub(r.sa.v, r.sb.v)),
              rPrimary: r.sa.r, vPrimary: r.sa.v, rSecondary: r.sb.r, vSecondary: r.sb.v });
        }
      }
    }
    o.onProgress?.(Math.min(1, (s0 + chunk) / nSteps));
  }
  const encounters = [...found.values()].sort((a, b) => a.tca.getTime() - b.tca.getTime());
  return { encounters, stats: { candidatesPerPrimary: cands.reduce((s, c) => s + c.length, 0) / o.primaries.length, pairsChecked: pairs, refined, ms: performance.now() - t0 } };
}

/**
 * Screen one arbitrary trajectory (e.g. the primary after a planned burn) against candidate objects. The trajectory is a function
 * of time; its velocity is taken by central difference.
 */
export function screenPath(o: { path: (t: Date) => V3 | null; sats: SatRec[]; candidates: number[]; start: Date; end: Date; stepSec?: number; thresholdKm?: number; batch?: BatchPropagator; exclude?: number[] }) {
  const step = o.stepSec ?? 60, thr = o.thresholdKm ?? 5, batch = o.batch ?? jsBatch;
  const cands = o.candidates.filter((j) => !o.exclude?.includes(j));
  const nSteps = Math.ceil((o.end.getTime() - o.start.getTime()) / 1000 / step) + 1;
  const out: { secondary: number; tca: Date; missKm: number }[] = [];
  const pathDist = (j: number, t: Date) => { const p = o.path(t), s = stateAt(o.sats[j], t); return p && s ? norm(sub(p, s.r)) : Infinity; };
  for (let s0 = 0; s0 < nSteps; s0 += 60) {
    const times = Array.from({ length: Math.min(60, nSteps - s0) }, (_, k) => new Date(o.start.getTime() + (s0 + k) * step * 1000));
    const eph = batch(cands.map((j) => o.sats[j]), times);
    const T = times.length;
    times.forEach((t, k) => {
      const p = o.path(t), pa = o.path(new Date(t.getTime() - 500)), pb = o.path(new Date(t.getTime() + 500));
      if (!p || !pa || !pb) return;
      const pv = [(pb[0] - pa[0]), (pb[1] - pa[1]), (pb[2] - pa[2])];
      cands.forEach((j, ci) => {
        const b = (ci * T + k) * 3;
        const dx = eph.pos[b] - p[0], dy = eph.pos[b + 1] - p[1], dz = eph.pos[b + 2] - p[2];
        if (!(Math.abs(dx) < 1000 && Math.abs(dy) < 1000 && Math.abs(dz) < 1000)) return;
        const vx = eph.vel[b] - pv[0], vy = eph.vel[b + 1] - pv[1], vz = eph.vel[b + 2] - pv[2];
        const vv = vx * vx + vy * vy + vz * vz, tau = vv > 0 ? -(dx * vx + dy * vy + dz * vz) / vv : 0;
        if (Math.abs(tau) > step / 2 + 1 || Math.hypot(dx + tau * vx, dy + tau * vy, dz + tau * vz) > thr + 2) return;
        const base = t.getTime() + tau * 1000;
        const m = brentMin((dt) => pathDist(j, new Date(base + dt * 1000)), -step, step, 1e-9, 200);
        if (m.fx <= thr && !out.some((e) => e.secondary === j && Math.abs(e.tca.getTime() - base) < 600e3)) out.push({ secondary: j, tca: new Date(base + m.x * 1000), missKm: m.fx });
      });
    });
  }
  return out.sort((a, b) => a.tca.getTime() - b.tca.getTime());
}

/**
 * Reference screen for evaluation only: no shell filter, short fixed step, local minima of the sampled distance refined with Brent.
 * Slow by design; it is the "ground truth" the fast screen is scored against on a subset of the catalog.
 */
export function bruteForce(o: ScreenOptions & { secondaries: number[] }): Encounter[] {
  const step = o.stepSec ?? 5, thr = o.thresholdKm ?? 5, batch = o.batch ?? jsBatch;
  const nSteps = Math.ceil((o.hours * 3600) / step) + 1;
  const idx = [...new Set([...o.primaries, ...o.secondaries])];
  const slot = new Map(idx.map((j, k) => [j, k]));
  const out: Encounter[] = [];
  const chunk = 720;
  const prev = new Map<string, [number, number]>(); // pair -> last two distances
  for (let s0 = 0; s0 < nSteps; s0 += chunk) {
    const times = Array.from({ length: Math.min(chunk, nSteps - s0) }, (_, k) => new Date(o.start.getTime() + (s0 + k) * step * 1000));
    const eph = batch(idx.map((j) => o.sats[j]), times);
    const T = times.length;
    for (const p of o.primaries) for (const j of o.secondaries) {
      if (j === p) continue;
      const key = `${p}:${j}`;
      let [d2, d1] = prev.get(key) ?? [Infinity, Infinity];
      const a0 = slot.get(p)! * T, b0 = slot.get(j)! * T;
      for (let k = 0; k < T; k++) {
        const a = (a0 + k) * 3, b = (b0 + k) * 3;
        const d = Math.hypot(eph.pos[b] - eph.pos[a], eph.pos[b + 1] - eph.pos[a + 1], eph.pos[b + 2] - eph.pos[a + 2]);
        if (d1 < d2 && d1 <= d && d1 < 200) {
          const tPrev = new Date(o.start.getTime() + (s0 + k - 1) * step * 1000);
          const r = refineTca(o.sats[p], o.sats[j], tPrev, step);
          if (r.missKm <= thr && !r.edge)
            out.push({ primary: p, secondary: j, tca: r.tca, missKm: r.missKm, relSpeedKms: norm(sub(r.sa.v, r.sb.v)), rPrimary: r.sa.r, vPrimary: r.sa.v, rSecondary: r.sb.r, vSecondary: r.sb.v });
        }
        d2 = d1; d1 = d;
      }
      prev.set(key, [d2, d1]);
    }
  }
  return out;
}

/** Match two encounter lists (same pair, TCA within 60 s). */
export function matchEncounters(found: Encounter[], truth: Encounter[]) {
  const used = new Set<number>();
  let tp = 0;
  for (const f of found) {
    const k = truth.findIndex((t, i) => !used.has(i) && ((t.primary === f.primary && t.secondary === f.secondary) || (t.primary === f.secondary && t.secondary === f.primary)) && Math.abs(t.tca.getTime() - f.tca.getTime()) < 60000);
    if (k >= 0) { used.add(k); tp++; }
  }
  return { tp, precision: found.length ? tp / found.length : 1, recall: truth.length ? tp / truth.length : 1, found: found.length, truth: truth.length };
}
