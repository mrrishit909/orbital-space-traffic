// Application state (the source of truth). Animation reads from here; nothing in the scene writes business state except
// through these actions.
import { useSyncExternalStore } from "react";
import { demoWindow, matches, notificationText, validateRule, type AlertRule, type Conjunction, type Pass } from "@orbital/domain";
import { next, type JourneyEvent, type View } from "./journey.ts";
import { makeProvider, withRetry, type DataProvider, type Delivery, type SavedRule } from "./provider.ts";
import type { CompactCatalog, PlanOption } from "./worker/protocol.ts";
import { PropagationClient } from "./worker/client.ts";

export interface Obj { norad: number; name: string; type: string; operator: string | null; family: string; radiusM: number; massKg: number; sigma: [number, number, number]; l1: string; l2: string; i: number }

export interface Notice { id: string; at: number; text: string; channel: string; delivered: string }

export interface AppState {
  view: View;
  catalog: CompactCatalog | null;
  objects: Obj[];
  byNorad: Map<number, Obj>;
  conjunctions: Conjunction[];
  load: { status: "idle" | "loading" | "ready" | "error"; message?: string; wasm?: boolean; workerMs?: number };
  feed: { status: "ok" | "down" | "retrying" | "recovered"; attempt: number; waitMs: number; lastGood: number | null; message?: string };
  window: { start: number; end: number; now: number };
  simTime: number;
  playing: boolean;
  speed: number;
  selected: number | null;
  conjunctionId: string | null;
  plan: { status: "idle" | "running" | "done" | "error"; stage?: string; fraction?: number; options?: PlanOption[]; rejected?: PlanOption[]; frontier?: number; ms?: number; error?: string; chosen: 0 | 1 | null };
  passes: { norad: number; list: Pass[] } | null;
  rules: SavedRule[];
  notices: Notice[];
  listView: boolean;
  reduced: boolean;
  motionPaused: boolean;
  hud: boolean;
  palette: boolean;
  alertOpen: boolean;
  help: boolean;
  stress: boolean;
  webgl: "ok" | "lost" | "unsupported";
  announce: string;
}

const initial: AppState = {
  view: "intro0", catalog: null, objects: [], byNorad: new Map(), conjunctions: [],
  load: { status: "idle" }, feed: { status: "ok", attempt: 0, waitMs: 0, lastGood: null },
  window: { start: 0, end: 0, now: 0 }, simTime: 0, playing: false, speed: 60, selected: null, conjunctionId: null,
  plan: { status: "idle", chosen: null }, passes: null, rules: [], notices: [], listView: false, reduced: false, motionPaused: false,
  hud: false, palette: false, alertOpen: false, help: false, stress: false, webgl: "ok", announce: "",
};

let state: AppState = initial;
const subs = new Set<() => void>();
export const get = () => state;
export function set(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
  state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
  for (const s of subs) s();
}
export function useApp<T>(sel: (s: AppState) => T): T {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => subs.delete(cb); }, () => sel(state), () => sel(initial));
}

export const provider: DataProvider = makeProvider();

/** The simulation clock as rendered (advanced per frame while playing); the store's simTime follows it a few times a second. */
export const clock = { t: 0, lastSync: 0 };
/** Jump the clock (scrubber, keyboard, deep link, opening a conjunction). */
export function jump(t: number) {
  const w = state.window;
  clock.t = w.end ? Math.max(w.start, Math.min(w.end, t)) : t;
  set({ simTime: clock.t });
}
export let worker: PropagationClient | null = null;

export function send(e: JourneyEvent) { set((s) => ({ view: next(s.view, e) })); }
export const say = (announce: string) => set({ announce });

function decode(c: CompactCatalog): Obj[] {
  return c.objects.map((o, i) => ({ norad: o[0], name: o[1], type: o[2], operator: o[3] < 0 ? null : c.operators[o[3]].slug, family: o[4], radiusM: o[5], massKg: o[6], sigma: [o[7], o[8], o[9]], l1: o[10], l2: o[11], i }));
}

/** Load (or reload) the catalog through the provider, retrying with backoff when the feed is down. */
export async function loadCatalog(opts: { extra?: number } = {}) {
  const first = state.catalog === null;
  set({ load: { status: "loading" } });
  try {
    const cat = await withRetry(() => provider.loadCatalog(), (attempt, ms, err) => {
      set((s) => ({ feed: { ...s.feed, status: "retrying", attempt, waitMs: ms, message: err.message } }));
      say(`Element-set feed unavailable. Retrying in ${Math.round(ms / 1000)} seconds.`);
    }, first ? 6 : 8);
    const cj = await provider.loadConjunctions();
    const objects = decode(cat);
    worker?.terminate();
    worker = new PropagationClient({ type: "init", catalog: cat, extra: opts.extra ?? (state.stress ? 50000 - cat.objects.length : 0) });
    const r = await worker.ready;
    const w = demoWindow(cat.epoch);
    const recovered = state.feed.status === "retrying" || state.feed.status === "down";
    set((s) => ({
      catalog: cat, objects, byNorad: new Map(objects.map((o) => [o.norad, o])), conjunctions: cj.conjunctions, window: w,
      load: { status: "ready", wasm: r.wasm, workerMs: Math.round(r.ms) },
      feed: { status: recovered ? "recovered" : "ok", attempt: 0, waitMs: 0, lastGood: Date.now() },
    }));
    if (!clock.t) jump(w.now);
    if (recovered) say(`Feed recovered: ${objects.length.toLocaleString("en-US")} element sets refreshed.`);
  } catch (e) {
    set((s) => ({ load: { status: s.catalog ? "ready" : "error", message: (e as Error).message }, feed: { ...s.feed, status: "down", message: (e as Error).message } }));
    say("Element-set feed is down. Showing the last good catalog.");
  }
}

export function setStress(on: boolean) {
  set({ stress: on });
  return loadCatalog({ extra: on ? 50000 - (state.catalog?.objects.length ?? 18050) : 0 });
}

export function select(norad: number | null) {
  if (norad === null) { set({ selected: null, passes: null }); send({ type: "CLEAR" }); return; }
  const o = state.byNorad.get(norad);
  if (!o) return;
  set({ selected: norad, passes: null });
  send({ type: "SELECT" });
  say(`Selected ${o.name}, ${o.type.replace("_", " ")}${o.operator ? `, operator ${o.operator}` : ""}.`);
  const w = state.window;
  worker?.call<"passes">({ type: "passes", norad, start: w.now, end: w.end }).then((m) => { if (state.selected === norad) set({ passes: { norad, list: m.passes } }); });
}

export function openConjunction(id: string) {
  const c = state.conjunctions.find((x) => x.id === id || x.id.startsWith(id));
  if (!c) return;
  set({ conjunctionId: c.id, selected: c.primaryNorad, plan: { status: "idle", chosen: null }, playing: false });
  jump(Date.parse(c.tca) - 60_000);
  send({ type: "OPEN_CONJUNCTION" });
  const a = state.byNorad.get(c.primaryNorad)?.name, b = state.byNorad.get(c.secondaryNorad)?.name;
  say(`Conjunction ${a} with ${b}: closest approach ${Math.round(c.missM)} metres, probability of collision ${c.pc.toExponential(1)}, ${c.risk} risk.`);
}

export async function planAvoidance() {
  const c = state.conjunctions.find((x) => x.id === state.conjunctionId);
  if (!c || !worker) return;
  send({ type: "PLAN" });
  set({ plan: { status: "running", stage: "Starting", fraction: 0, chosen: null } });
  try {
    const mass = state.byNorad.get(c.primaryNorad)?.massKg ?? 300;
    const m = await worker.call<"plan">({ type: "plan", conjunction: c, notBefore: state.window.now, massKg: mass }, (stage, fraction) => set((s) => ({ plan: { ...s.plan, stage, fraction } })));
    set({ plan: { status: "done", options: m.options, rejected: m.rejected, frontier: m.frontier, ms: Math.round(m.ms), chosen: null } });
    if (m.options.length === 2) say(`Two avoidance options. Option A: ${(m.options[0].dvMs * 100).toFixed(1)} centimetres per second, ${m.options[0].leadOrbits} orbits before closest approach. Option B: ${(m.options[1].dvMs * 100).toFixed(1)} centimetres per second.`);
  } catch (e) {
    set({ plan: { status: "error", error: (e as Error).message, chosen: null } });
  }
}

export async function saveRule(rule: AlertRule) {
  const errors = validateRule(rule);
  if (errors.length) return errors;
  const key = crypto.randomUUID();
  const { rule: saved, deliveries } = await provider.saveRule(rule, key);
  const fleet = new Set(state.objects.filter((o) => o.operator === "aurora").map((o) => o.norad));
  const names = new Map(state.objects.map((o) => [o.norad, o.name]));
  const hits = provider.kind === "api" ? [] : matches(saved, state.conjunctions, fleet, new Date(state.window.now));
  const notices: Notice[] = provider.kind === "api"
    ? deliveries.map((d: Delivery, k) => ({ id: `${saved.id}-${k}`, at: Date.now(), text: d.text, channel: d.channel, delivered: d.delivered }))
    : hits.map((c, k) => ({ id: `${saved.id}-${k}`, at: Date.now(), text: notificationText(saved, c, names), channel: saved.channel, delivered: "simulated" }));
  set((s) => ({ rules: [...s.rules, saved], notices: [...notices, ...s.notices], alertOpen: false }));
  say(`Alert rule saved. ${notices.length} notification${notices.length === 1 ? "" : "s"} ${provider.kind === "api" ? "sent" : "simulated"}.`);
  return [];
}
