"use client";
// Text-and-table alternative to the 3D scene: every fact the globe shows is reachable here without WebGL or motion.
import { useMemo, useState } from "react";
import { relTime } from "@orbital/domain";
import { get, openConjunction, select, useApp } from "../store.ts";
import { metres, n, pc, riskIcon, riskText, utc } from "./fmt.ts";

export default function ListView() {
  const cj = useApp((s) => s.conjunctions);
  const objects = useApp((s) => s.objects);
  const now = useApp((s) => s.window.now);
  const t = useApp((s) => s.simTime);
  const webgl = useApp((s) => s.webgl);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const rows = useMemo(() => objects.filter((o) => !q || o.name.toLowerCase().includes(q.toLowerCase()) || String(o.norad).includes(q)), [objects, q]);
  const name = (x: number) => get().byNorad.get(x)?.name ?? x;
  return (
    <main className="listview" aria-label="List view">
      {webgl !== "ok" ? <p className="banner warn" role="status">{webgl === "lost" ? "The GPU context was lost. The 3D view will come back when the browser restores it; everything is available here meanwhile." : "This browser has no WebGL, so the sandbox runs as tables."}</p> : null}
      <p>Scene time {utc(t)}. {n(objects.length)} objects, {n(cj.length)} conjunctions under 5 km in the next 24 hours.</p>
      <h2>Conjunctions</h2>
      <div className="table-wrap">
        <table>
          <caption>Close approaches of the Aurora fleet, ordered by time</caption>
          <thead><tr><th scope="col">Risk</th><th scope="col">Primary</th><th scope="col">Secondary</th><th scope="col">Closest approach</th><th scope="col">Miss</th><th scope="col">Pc</th><th scope="col" /></tr></thead>
          <tbody>
            {cj.map((c) => (
              <tr key={c.id}>
                <td>{riskIcon[c.risk]} {riskText[c.risk]}</td><td>{name(c.primaryNorad)}</td><td>{name(c.secondaryNorad)}</td>
                <td>{utc(Date.parse(c.tca))} ({relTime(Date.parse(c.tca), now)})</td><td>{metres(c.missM)}</td><td>{pc(c.pc)}</td>
                <td><button onClick={() => openConjunction(c.id)}>Open</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2>Objects</h2>
      <label>Filter <input value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} placeholder="name or id" /></label>
      <div className="table-wrap">
        <table>
          <caption>{n(rows.length)} objects{rows.length > 100 ? `, page ${page + 1} of ${Math.ceil(rows.length / 100)}` : ""}</caption>
          <thead><tr><th scope="col">Id</th><th scope="col">Name</th><th scope="col">Type</th><th scope="col">Operator</th><th scope="col">Radius</th><th scope="col" /></tr></thead>
          <tbody>
            {rows.slice(page * 100, page * 100 + 100).map((o) => (
              <tr key={o.norad}><td>{o.norad}</td><td>{o.name}</td><td>{o.type.replace("_", " ")}</td><td>{o.operator ?? "—"}</td><td>{o.radiusM} m</td><td><button onClick={() => select(o.norad)}>Inspect</button></td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row"><button disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button><button disabled={(page + 1) * 100 >= rows.length} onClick={() => setPage(page + 1)}>Next</button></div>
    </main>
  );
}
