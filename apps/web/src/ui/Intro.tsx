"use client";
// The public story, four chapters long, scrolled over the live globe. The numbers are counted from the loaded catalog and screen.
import { useEffect, useRef } from "react";
import { get, openConjunction, send, useApp } from "../store.ts";
import { introScroll } from "../scene/Scene.tsx";
import { n, pc } from "./fmt.ts";

export default function Intro() {
  const ref = useRef<HTMLDivElement>(null);
  const objects = useApp((s) => s.objects);
  const cj = useApp((s) => s.conjunctions);
  const ready = useApp((s) => s.load.status === "ready");
  const view = useApp((s) => s.view);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      const secs = [...el.querySelectorAll<HTMLElement>("[data-chapter]")];
      const mid = el.scrollTop + el.clientHeight * 0.5;
      let f = 0;
      secs.forEach((s, i) => { const top = s.offsetTop, h = s.offsetHeight; if (mid >= top) f = Math.min(3, i + Math.min(1, (mid - top) / h)); });
      introScroll.f = Math.max(0, f - 0.5);
      const chapter = Math.min(3, Math.round(introScroll.f));
      if (get().view !== `intro${chapter}`) send({ type: "CHAPTER", n: chapter });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  const count = (f: (o: (typeof objects)[number]) => boolean) => n(objects.filter(f).length);
  const alt = (o: (typeof objects)[number]) => Math.cbrt(398600.8 / ((+o.l2.slice(52, 63) * 2 * Math.PI) / 86400) ** 2) - 6378.135;
  const high = cj.filter((c) => c.risk === "high");
  const fleet = objects.filter((o) => o.operator === "aurora").length;
  const go = (n: number) => ref.current?.querySelectorAll<HTMLElement>("[data-chapter]")[n]?.scrollIntoView({ behavior: get().reduced ? "auto" : "smooth" });

  return (
    <div className="intro" ref={ref} aria-label="Introduction" hidden={!view.startsWith("intro")}>
      <section data-chapter="0" className="chapter">
        <p className="kicker">ORBITAL · space traffic and collision intelligence</p>
        <h1>Near-Earth space, as an operator sees it.</h1>
        <p>{ready ? n(objects.length) : "18,050"} objects in a synthetic catalog, propagated live in your browser. Scroll to fall toward Earth.</p>
        <p className="badge-line"><span className="badge">SYNTHETIC DATA</span> Every object, operator and close approach here is generated. Nothing is a real satellite.</p>
        <button className="ghost" onClick={() => go(1)}>Start</button>
      </section>
      <section data-chapter="1" className="chapter">
        <h2>Every point follows its own orbit.</h2>
        <p>Positions come from SGP4, the model used with published two-line element sets, running in a Web Worker (WASM). The globe turns with sidereal time and is lit by the Sun for the scene&apos;s moment.</p>
      </section>
      <section data-chapter="2" className="chapter">
        <h2>Shells, not a cloud.</h2>
        <p>Objects appear by altitude as you scroll:</p>
        <ul className="facts">
          <li><b>{ready ? count((o) => alt(o) < 2000) : "—"}</b> in low Earth orbit (below 2,000 km)</li>
          <li><b>{ready ? count((o) => alt(o) >= 2000 && alt(o) < 30000) : "—"}</b> in medium and highly elliptical orbits</li>
          <li><b>{ready ? count((o) => alt(o) >= 30000) : "—"}</b> near geostationary altitude</li>
        </ul>
        <p className="legend"><span className="sw payload" /> payload (disc) <span className="sw rocket_body" /> rocket body (square) <span className="sw debris" /> debris (dot)</p>
      </section>
      <section data-chapter="3" className="chapter">
        <h2>Your fleet: {fleet} satellites at 550 km.</h2>
        <p>Screened against the whole catalog for the next 24 hours: <b>{n(cj.length)}</b> close approaches under 5 km, <b>{high.length}</b> with a probability of collision above 1 in 10,000{high[0] ? <> (the worst is {pc(high[0].pc)})</> : null}.</p>
        <div className="cta">
          <button className="primary" onClick={() => send({ type: "ENTER" })}>Open the operations sandbox</button>
          {high[0] ? <button className="ghost" onClick={() => openConjunction(high[0].id)}>Go to the high-risk conjunction</button> : null}
        </div>
      </section>
    </div>
  );
}
