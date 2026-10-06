// Deep links: the product state that matters is in the query string, so any view can be shared and restored.
export interface LinkState { t?: number; sel?: number; cj?: string; mode?: "encounter" | "plan"; opt?: 0 | 1; view?: "list"; rm?: boolean; enter?: boolean }

export function readLink(search: string): LinkState {
  const q = new URLSearchParams(search);
  const s: LinkState = {};
  const t = q.get("t");
  if (t) { const ms = Date.parse(t); if (!Number.isNaN(ms)) s.t = ms; }
  const sel = Number(q.get("sel"));
  if (Number.isInteger(sel) && sel > 0) s.sel = sel;
  const cj = q.get("cj");
  if (cj && /^[0-9a-f-]{8,36}$/.test(cj)) s.cj = cj;
  const mode = q.get("mode");
  if (mode === "encounter" || mode === "plan") s.mode = mode;
  const opt = q.get("opt");
  if (opt === "a" || opt === "b") s.opt = opt === "a" ? 0 : 1;
  if (q.get("view") === "list") s.view = "list";
  if (q.get("rm") === "1") s.rm = true;
  if (q.get("enter") === "1") s.enter = true;
  return s;
}

export function writeLink(s: LinkState): string {
  const q = new URLSearchParams();
  if (s.t !== undefined) q.set("t", new Date(Math.round(s.t / 1000) * 1000).toISOString().replace(".000Z", "Z"));
  if (s.sel) q.set("sel", String(s.sel));
  if (s.cj) q.set("cj", s.cj.slice(0, 8));
  if (s.mode) q.set("mode", s.mode);
  if (s.opt !== undefined) q.set("opt", s.opt === 0 ? "a" : "b");
  if (s.view) q.set("view", s.view);
  if (s.rm) q.set("rm", "1");
  const str = q.toString();
  return str ? `?${str}` : "";
}
