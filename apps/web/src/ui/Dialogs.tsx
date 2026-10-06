"use client";
// Alert-rule form, command palette and keyboard help. Native <dialog> for focus trapping and Escape.
import { useEffect, useMemo, useRef, useState } from "react";
import type { AlertRule } from "@orbital/domain";
import { get, jump, openConjunction, saveRule, select, set, useApp } from "../store.ts";
import { metres, pc, riskIcon } from "./fmt.ts";

function useDialog(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
    const c = () => onClose();
    d.addEventListener("close", c);
    return () => d.removeEventListener("close", c);
  }, [open, onClose]);
  return ref;
}

export function AlertDialog() {
  const open = useApp((s) => s.alertOpen);
  const close = useMemo(() => () => set({ alertOpen: false }), []);
  const ref = useDialog(open, close);
  const [rule, setRule] = useState<AlertRule>({ name: "High Pc on my fleet", scope: "fleet", minPc: 1e-4, withinHours: 24, channel: "email", target: "ops@aurora.example" });
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  return (
    <dialog ref={ref} aria-labelledby="alert-title" className="dialog">
      <form method="dialog" onSubmit={async (e) => { e.preventDefault(); setBusy(true); try { setErrors(await saveRule(rule)); } catch (err) { setErrors([(err as Error).message]); } setBusy(false); }}>
        <h2 id="alert-title">New alert rule</h2>
        <label>Name <input value={rule.name} onChange={(e) => setRule({ ...rule, name: e.target.value })} /></label>
        <label>Applies to <select value={rule.scope === "fleet" ? "fleet" : "list"} onChange={(e) => setRule({ ...rule, scope: e.target.value === "fleet" ? "fleet" : [get().selected ?? 70001] })}><option value="fleet">My whole fleet (Aurora, 60 satellites)</option><option value="list">Only the selected satellite</option></select></label>
        <label>Notify when Pc is at least <select value={rule.minPc} onChange={(e) => setRule({ ...rule, minPc: +e.target.value })}>{[1e-3, 1e-4, 1e-5, 1e-6].map((v) => <option key={v} value={v}>{pc(v)}</option>)}</select></label>
        <label>Within the next (hours) <input type="number" min={1} max={168} value={rule.withinHours} onChange={(e) => setRule({ ...rule, withinHours: +e.target.value })} /></label>
        <label>Channel <select value={rule.channel} onChange={(e) => setRule({ ...rule, channel: e.target.value as AlertRule["channel"], target: e.target.value === "email" ? "ops@aurora.example" : "https://hooks.aurora.example/conjunctions" })}><option value="email">E-mail</option><option value="webhook">Webhook</option></select></label>
        <label>Send to <input value={rule.target} onChange={(e) => setRule({ ...rule, target: e.target.value })} /></label>
        {errors.length ? <ul className="errors" role="alert">{errors.map((x) => <li key={x}>{x}</li>)}</ul> : null}
        <div className="row"><button className="primary" type="submit" disabled={busy}>{busy ? "Saving…" : "Save rule"}</button><button type="button" onClick={close}>Cancel</button></div>
        <p className="muted small">In this public sandbox nothing is sent: the rule is evaluated against the screened conjunctions and the notification is simulated. The Docker stack sends it to a local mail sink.</p>
      </form>
    </dialog>
  );
}

export function Palette() {
  const open = useApp((s) => s.palette);
  const close = useMemo(() => () => set({ palette: false }), []);
  const ref = useDialog(open, close);
  const [q, setQ] = useState("");
  const [k, setK] = useState(0);
  const objects = useApp((s) => s.objects);
  const cj = useApp((s) => s.conjunctions);
  const items = useMemo(() => {
    const t = q.trim().toLowerCase();
    const actions = [
      { label: "Go to now", run: () => jump(get().window.now) },
      { label: "Toggle list view", run: () => set((s) => ({ listView: !s.listView })) },
      { label: "Toggle reduced motion", run: () => set((s) => ({ reduced: !s.reduced })) },
      { label: "Play / pause time", run: () => set((s) => ({ playing: !s.playing })) },
      { label: "Create alert rule", run: () => set({ alertOpen: true }) },
    ].filter((a) => !t || a.label.toLowerCase().includes(t));
    const conj = cj.filter((c) => c.risk !== "low").filter((c) => !t || `${get().byNorad.get(c.primaryNorad)?.name} ${get().byNorad.get(c.secondaryNorad)?.name}`.toLowerCase().includes(t))
      .slice(0, 5).map((c) => ({ label: `${riskIcon[c.risk]} ${get().byNorad.get(c.primaryNorad)?.name} vs ${get().byNorad.get(c.secondaryNorad)?.name} · ${metres(c.missM)}`, run: () => openConjunction(c.id) }));
    const objs = t.length < 2 ? [] : objects.filter((o) => o.name.toLowerCase().includes(t) || String(o.norad) === t).slice(0, 8).map((o) => ({ label: `${o.name} · ${o.norad} · ${o.type.replace("_", " ")}`, run: () => select(o.norad) }));
    return [...objs, ...conj, ...actions];
  }, [q, objects, cj]);
  const run = (i: number) => { items[i]?.run(); set({ palette: false }); setQ(""); };
  return (
    <dialog ref={ref} className="dialog palette" aria-label="Command palette">
      <input autoFocus placeholder="Search objects by name or id, conjunctions, actions…" value={q} role="combobox" aria-expanded aria-controls="palette-list" aria-activedescendant={`pi-${k}`}
        onChange={(e) => { setQ(e.target.value); setK(0); }}
        onKeyDown={(e) => { if (e.key === "ArrowDown") { e.preventDefault(); setK(Math.min(items.length - 1, k + 1)); } if (e.key === "ArrowUp") { e.preventDefault(); setK(Math.max(0, k - 1)); } if (e.key === "Enter") { e.preventDefault(); run(k); } }} />
      <ul id="palette-list" role="listbox">
        {items.map((it, i) => <li key={i} id={`pi-${i}`} role="option" aria-selected={i === k}><button onClick={() => run(i)}>{it.label}</button></li>)}
      </ul>
    </dialog>
  );
}

export function Help() {
  const open = useApp((s) => s.help);
  const close = useMemo(() => () => set({ help: false }), []);
  const ref = useDialog(open, close);
  const keys = [["⌘K / Ctrl K / /", "search and commands"], ["Space", "play / pause time"], ["← →", "scrub 10 minutes (Shift: 1 hour)"], ["[ ]", "previous / next conjunction"], ["L", "list view"], ["M", "reduced motion"], ["P", "pause all motion"], ["Esc", "back"], ["Alt + arrows, Alt + = / -", "turn and zoom the globe"]];
  return (
    <dialog ref={ref} className="dialog" aria-labelledby="help-title">
      <h2 id="help-title">Keyboard</h2>
      <table><tbody>{keys.map(([a, b]) => <tr key={a}><th scope="row"><kbd>{a}</kbd></th><td>{b}</td></tr>)}</tbody></table>
      <button onClick={close}>Close</button>
    </dialog>
  );
}
