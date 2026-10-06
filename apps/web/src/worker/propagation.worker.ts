/// <reference lib="webworker" />
// Client-side propagation for the sandbox: WASM bulk SGP4 over the whole catalog (JS fallback), plus the heavier previews
// (maneuver planning, re-screening the burned orbit, ground-station passes) so the page never blocks.
import { parse, jsBatch, planWithRescreen, stateAt, passes, type BatchPropagator } from "@orbital/domain";
import { wasmBatch } from "../../../../packages/domain/src/wasm.ts";
import type { SatRec } from "satellite.js";
import type { CompactCatalog, FromWorker, ToWorker } from "./protocol.ts";

const post = (m: FromWorker, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);
let sats: SatRec[] = [];
let norads: number[] = [];
let index = new Map<number, number>();
let meta: { radiusM: number; sigma: [number, number, number] }[] = [];
let batch: BatchPropagator = jsBatch;
let wasm = false;
let epoch = 0;

function toScene(pos: Float64Array, vel: Float64Array, n: number, T: number, k: number) {
  const p = new Float32Array(n * 3), v = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const o = (i * T + k) * 3;
    // SGP4 failure -> park the point far away (shader hides it)
    if (Number.isNaN(pos[o])) { p.set([1e6, 1e6, 1e6], i * 3); continue; }
    p[i * 3] = pos[o] / 1000; p[i * 3 + 1] = pos[o + 2] / 1000; p[i * 3 + 2] = -pos[o + 1] / 1000;
    v[i * 3] = vel[o] / 1000; v[i * 3 + 1] = vel[o + 2] / 1000; v[i * 3 + 2] = -vel[o + 1] / 1000;
  }
  return { p, v };
}

/** Stress mode: extra synthetic objects made by perturbing existing element sets (same shells, shifted phase). */
function extraSats(base: CompactCatalog["objects"], n: number): SatRec[] {
  const out: SatRec[] = [];
  for (let k = 0; k < n; k++) {
    const src = parse(base[k % base.length][10], base[k % base.length][11]);
    const s = Object.assign(Object.create(Object.getPrototypeOf(src)), src) as SatRec;
    s.mo = (src.mo + 0.7 + k * 2.399963) % (2 * Math.PI);
    s.nodeo = (src.nodeo + 0.3 * Math.sin(k)) % (2 * Math.PI);
    out.push(s);
  }
  return out;
}


self.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  try {
    if (m.type === "init") {
      const t0 = performance.now();
      epoch = Date.parse(m.catalog.epoch);
      sats = m.catalog.objects.map((o) => parse(o[10], o[11]));
      norads = m.catalog.objects.map((o) => o[0]);
      meta = m.catalog.objects.map((o) => ({ radiusM: o[5], sigma: [o[7], o[8], o[9]] }));
      if (m.extra > 0) { sats = sats.concat(extraSats(m.catalog.objects, m.extra)); norads = norads.concat(Array.from({ length: m.extra }, (_, k) => -1 - k)); }
      index = new Map(norads.map((n, i) => [n, i]));
      try { batch = await wasmBatch(); wasm = true; } catch { batch = jsBatch; wasm = false; }
      post({ type: "ready", n: sats.length, wasm, ms: performance.now() - t0 });
    } else if (m.type === "positions") {
      const t0 = performance.now();
      const eph = batch(sats, [new Date(m.t0), new Date(m.t1)]);
      const a = toScene(eph.pos, eph.vel, sats.length, 2, 0), b = toScene(eph.pos, eph.vel, sats.length, 2, 1);
      post({ type: "positions", id: m.id, t0: m.t0, t1: m.t1, p0: a.p, v0: a.v, p1: b.p, v1: b.v, ms: performance.now() - t0 }, [a.p.buffer, a.v.buffer, b.p.buffer, b.v.buffer]);
    } else if (m.type === "trail") {
      const s = sats[index.get(m.norad)!];
      const periodMin = (2 * Math.PI) / s.no;
      const pts = new Float32Array((m.samples + 1) * 3);
      for (let i = 0; i <= m.samples; i++) {
        const st = stateAt(s, new Date(m.t + (i / m.samples) * periodMin * 60000));
        if (st) pts.set([st.r[0] / 1000, st.r[2] / 1000, -st.r[1] / 1000], i * 3);
      }
      post({ type: "trail", id: m.id, norad: m.norad, points: pts, periodMin }, [pts.buffer]);
    } else if (m.type === "passes") {
      post({ type: "passes", id: m.id, passes: passes(sats[index.get(m.norad)!], new Date(m.start), new Date(m.end)) });
    } else if (m.type === "plan") {
      const t0 = performance.now();
      const r = planWithRescreen({ sats, meta, norads, epoch, conjunction: m.conjunction, notBefore: new Date(m.notBefore), massKg: m.massKg, batch,
        onProgress: (stage, fraction) => post({ type: "progress", id: m.id, stage, fraction }) });
      post({ type: "plan", id: m.id, options: r.options, rejected: r.rejected, frontier: r.frontier, ms: performance.now() - t0 });
    }
  } catch (e) {
    post({ type: "error", id: "id" in m ? m.id : -1, message: e instanceof Error ? e.message : String(e) });
  }
};
