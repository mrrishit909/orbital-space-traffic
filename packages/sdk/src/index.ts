// Typed client for the ORBITAL API (the shapes match docs/openapi.json). Adds the bearer token, a W3C traceparent per call, an
// Idempotency-Key on every mutation, follows nextCursor pagination, and turns error bodies into ApiError.
import type { AlertRule, Conjunction, PlanOption } from "@orbital/domain";

export class ApiError extends Error {
  status: number; code: string; traceId?: string;
  constructor(status: number, code: string, message: string, traceId?: string) { super(message); this.status = status; this.code = code; this.traceId = traceId; }
}
export interface SpaceObject { id: string; noradId: number; cosparId: string; name: string; objectType: "payload" | "rocket_body" | "debris" | "unknown"; operator: string | null; massKg: number; radiusM: number; family: string }
export interface StateVector { t: string; r: [number, number, number] | null; v: [number, number, number] | null }

const hex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");

export class OrbitalClient {
  private base: string; private token?: string;
  constructor(base: string, token?: string) { this.base = base.replace(/\/$/, ""); this.token = token; }

  private async req<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    const headers: Record<string, string> = { traceparent: `00-${hex(16)}-${hex(8)}-01` };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    if (method !== "GET") headers["idempotency-key"] = idempotencyKey ?? crypto.randomUUID();
    const r = await fetch(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = r.status === 204 ? null : await r.json().catch(() => null);
    if (!r.ok) throw new ApiError(r.status, j?.error?.code ?? "http_error", j?.error?.message ?? r.statusText, j?.error?.traceId);
    return j as T;
  }
  objects(q: { type?: string; operator?: string; bbox?: [number, number, number, number]; at?: string; limit?: number; cursor?: string } = {}) {
    const p = new URLSearchParams(Object.entries({ ...q, bbox: q.bbox?.join(",") }).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
    return this.req<{ items: SpaceObject[]; nextCursor: string | null }>("GET", `/v1/objects?${p}`);
  }
  async *allObjects(q: { type?: string; operator?: string } = {}) {
    let cursor: string | undefined;
    do { const page = await this.objects({ ...q, limit: 1000, cursor }); yield* page.items; cursor = page.nextCursor ?? undefined; } while (cursor);
  }
  object(id: string | number) { return this.req<SpaceObject & { tle: { line1: string; line2: string; epoch: string } }>("GET", `/v1/objects/${id}`); }
  ephemeris(id: string | number, from: string, to: string, step = 60) { return this.req<{ frame: "TEME"; points: StateVector[] }>("GET", `/v1/objects/${id}/ephemeris?from=${from}&to=${to}&step=${step}`); }
  propagate(body: { noradId?: number; line1?: string; line2?: string; times: string[] }) { return this.req<{ points: StateVector[] }>("POST", "/v1/propagate", body); }
  conjunctions(q: { from?: string; to?: string; risk?: "high" | "medium" | "low" } = {}) { return this.req<{ epoch: string; conjunctions: Conjunction[]; nextCursor: string | null }>("GET", `/v1/conjunctions?${new URLSearchParams(q as Record<string, string>)}`); }
  conjunction(id: string) { return this.req<Conjunction>("GET", `/v1/conjunctions/${id}`); }
  planManeuvers(id: string, body: { notBefore?: string } = {}, idempotencyKey?: string) { return this.req<{ conjunctionId: string; options: PlanOption[]; rejected: PlanOption[]; frontier: number; maneuverIds: string[] }>("POST", `/v1/conjunctions/${id}/maneuver-scenarios`, body, idempotencyKey); }
  createAlertRule(rule: AlertRule, idempotencyKey?: string) { return this.req<{ rule: AlertRule & { id: string }; deliveries: { text: string; delivered: string }[] }>("POST", "/v1/alerts/rules", rule, idempotencyKey); }
  groundStations() { return this.req<{ items: { id: string; name: string; latDeg: number; lonDeg: number }[] }>("GET", "/v1/ground-stations"); }
}
