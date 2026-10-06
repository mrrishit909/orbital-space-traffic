"use client";
import dynamic from "next/dynamic";
import { useEffect, useRef } from "react";
import { prefersReducedMotion } from "@orbital/motion";
import { get, jump, loadCatalog, openConjunction, planAvoidance, select, send, set, useApp } from "./store.ts";
import { readLink, writeLink } from "./url.ts";
import { isIntro } from "./journey.ts";
import { telemetry } from "./runtime.ts";
import Intro from "./ui/Intro.tsx";
import { Banner, ConjunctionList, EncounterReadout, Inspector, Notices, Timeline, TopBar } from "./ui/Sandbox.tsx";
import { AlertDialog, Help, Palette } from "./ui/Dialogs.tsx";
import ListView from "./ui/ListView.tsx";
import Hud from "./ui/Hud.tsx";

const Scene = dynamic(() => import("./scene/Scene.tsx"), { ssr: false });
const Encounter = dynamic(() => import("./scene/Encounter.tsx"), { ssr: false });

function hasWebGL() {
  try { return !!document.createElement("canvas").getContext("webgl2"); } catch { return false; }
}

function useKeyboard() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.closest?.("dialog")) return;
      const s = get();
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || e.key === "/") { e.preventDefault(); set({ palette: true }); return; }
      if (isIntro(s.view) || e.altKey || e.metaKey || e.ctrlKey) return;
      const order = s.conjunctions.filter((c) => c.risk !== "low");
      const at = order.findIndex((c) => c.id === s.conjunctionId);
      switch (e.key) {
        case " ": e.preventDefault(); set({ playing: !s.playing, motionPaused: false }); break;
        case "ArrowRight": jump((s.simTime || s.window.now) + (e.shiftKey ? 3600e3 : 600e3)); break;
        case "ArrowLeft": jump((s.simTime || s.window.now) - (e.shiftKey ? 3600e3 : 600e3)); break;
        case "]": if (order.length) openConjunction(order[(at + 1) % order.length].id); break;
        case "[": if (order.length) openConjunction(order[(at - 1 + order.length) % order.length].id); break;
        case "l": case "L": set({ listView: !s.listView }); break;
        case "m": case "M": set({ reduced: !s.reduced }); break;
        case "p": case "P": set({ motionPaused: !s.motionPaused, playing: false }); break;
        case "?": set({ help: true }); break;
        case "Escape": if (s.view === "plan") send({ type: "BACK" }); else if (s.view !== "explore") { select(null); set({ conjunctionId: null }); send({ type: "CLEAR" }); } break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** Restore state from the URL once data is loaded, then keep the URL in step with the state. */
function useDeepLink() {
  const ready = useApp((s) => s.load.status === "ready");
  const applied = useRef(false);
  useEffect(() => {
    if (!ready || applied.current) return;
    applied.current = true;
    const l = readLink(location.search);
    if (l.rm) set({ reduced: true });
    if (l.view) set({ listView: true });
    if (l.cj) { openConjunction(l.cj); if (l.mode === "plan") planAvoidance().then(() => { if (l.opt !== undefined) set((s) => ({ plan: { ...s.plan, chosen: l.opt! } })); }); }
    else if (l.sel) select(l.sel);
    else if (l.enter) send({ type: "ENTER" });
    if (l.t !== undefined) jump(l.t);
    let last = "";
    setInterval(() => {
      const s = get();
      if (isIntro(s.view)) return;
      const link = writeLink({
        t: s.playing ? undefined : s.simTime, sel: s.view === "focus" ? s.selected ?? undefined : undefined,
        cj: s.view === "encounter" || s.view === "plan" ? s.conjunctionId ?? undefined : undefined,
        mode: s.view === "plan" ? "plan" : s.view === "encounter" ? "encounter" : undefined, opt: s.view === "plan" ? s.plan.chosen ?? undefined : undefined,
        view: s.listView ? "list" : undefined, rm: s.reduced || undefined, enter: undefined,
      }) || "?enter=1";
      if (link !== last) { last = link; history.replaceState(null, "", link); }
    }, 400);
  }, [ready]);
}

export default function App() {
  const view = useApp((s) => s.view);
  const listView = useApp((s) => s.listView);
  const webgl = useApp((s) => s.webgl);
  const load = useApp((s) => s.load);
  const announce = useApp((s) => s.announce);
  const reduced = useApp((s) => s.reduced);
  const catalogLoaded = useApp((s) => s.catalog !== null);
  useKeyboard();
  useDeepLink();
  useEffect(() => {
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    set({ reduced: prefersReducedMotion() || readLink(location.search).rm === true, webgl: hasWebGL() ? "ok" : "unsupported" });
    const onChange = () => set({ reduced: mq.matches });
    mq.addEventListener("change", onChange);
    telemetry.start();
    loadCatalog();
    // read-only handle for the e2e tests and the demo recorder
    (window as unknown as { __orbital: unknown }).__orbital = { state: get, telemetry: () => telemetry.s };
    return () => mq.removeEventListener("change", onChange);
  }, []);
  useEffect(() => { document.documentElement.dataset.reduced = reduced ? "1" : "0"; }, [reduced]);
  const intro = isIntro(view);
  const show3d = !listView && webgl === "ok";
  const enc = view === "encounter" || view === "plan";
  return (
    <div className={`app view-${view} ${intro ? "is-intro" : "is-sandbox"}`}>
      <a className="skip" href="#main-panels">Skip to the panels</a>
      {webgl !== "unsupported" ? <div className="globe-wrap" aria-hidden={!show3d} style={{ visibility: show3d || intro ? "visible" : "hidden" }}><Scene /></div> : null}
      <div className="sr-only" role="status" aria-live="polite">{announce}</div>
      {load.status === "error" ? <div className="banner warn" role="alert">Could not load the catalog: {load.message}. <button onClick={() => loadCatalog()}>Retry</button></div> : null}
      {load.status === "loading" && !intro && !catalogLoaded ? <div className="loading" role="status">Loading catalog…</div> : null}
      <Intro />
      {!intro ? (
        <>
          <TopBar />
          <Banner />
          <div id="main-panels" className="panels">
            {listView || webgl !== "ok" ? <ListView /> : null}
            <ConjunctionList />
            <Inspector />
          </div>
          {enc && show3d ? (
            <section className="encounter" aria-label="Encounter view">
              <Encounter />
              <EncounterReadout />
            </section>
          ) : null}
          <Timeline />
          <Notices />
          <Hud />
        </>
      ) : null}
      <AlertDialog />
      <Palette />
      <Help />
    </div>
  );
}
