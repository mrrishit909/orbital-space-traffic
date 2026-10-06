// API contract, authorization matrix, tenant isolation, idempotency, rate limits and failure injection, against a real Postgres.
// Every 2xx/4xx body is validated against the OpenAPI document the server publishes.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Ajv } from "ajv";
import pg from "pg";
import WebSocket from "ws";
import { migrate } from "../src/migrate.ts";
import { seed } from "../src/seed.ts";
import { build } from "../src/server.ts";
import { pool } from "../src/db.ts";

type App = Awaited<ReturnType<typeof build>>;
let app: App;
let spec: { paths: Record<string, Record<string, { responses: Record<string, { content?: { "application/json"?: { schema: object } } }> }>> };
const ajv = new Ajv({ strict: false, allErrors: true });
ajv.addFormat("uuid", /^[0-9a-f-]{36}$/).addFormat("date-time", (s: string) => !Number.isNaN(Date.parse(s)));
const OP = { authorization: "Bearer aurora-operator-demo" }, VIEW = { authorization: "Bearer aurora-viewer-demo" }, OTHER = { authorization: "Bearer lattice-operator-demo" };

/** inject + check the response against the OpenAPI schema for that route and status */
async function call(method: "GET" | "POST", url: string, headers: Record<string, string> = {}, body?: unknown, route?: string) {
  const r = await app.inject({ method, url, headers: body ? { "content-type": "application/json", ...headers } : headers, payload: body ? JSON.stringify(body) : undefined });
  const path = route ?? url.split("?")[0];
  const schema = spec.paths[path]?.[method.toLowerCase()]?.responses?.[String(r.statusCode)]?.content?.["application/json"]?.schema;
  if (schema && r.headers["content-type"]?.toString().includes("json")) {
    const ok = ajv.validate(schema, r.json());
    if (!ok) throw new Error(`${method} ${url} ${r.statusCode} does not match its OpenAPI schema: ${ajv.errorsText()}`);
  }
  return r;
}

beforeAll(async () => {
  await migrate();
  await seed(undefined, true);
  app = await build({ logger: false, rateLimit: 40, mail: null });
  await app.ready();
  spec = app.swagger() as unknown as typeof spec;
}, 120_000);
afterAll(async () => { await app.close(); await pool.end(); });

describe("OpenAPI document", () => {
  it("is 3.1 and covers the blueprint's contract", () => {
    const s = app.swagger() as { openapi: string; paths: Record<string, unknown> };
    expect(s.openapi).toBe("3.1.0");
    for (const p of ["/v1/objects", "/v1/objects/{id}", "/v1/objects/{id}/ephemeris", "/v1/conjunctions", "/v1/conjunctions/{id}", "/v1/conjunctions/{id}/maneuver-scenarios", "/v1/propagate", "/v1/alerts/rules", "/v1/ground-stations"])
      expect(Object.keys(s.paths)).toContain(p);
  });
});

describe("catalog and ephemeris", () => {
  it("lists with pagination and filters", async () => {
    const a = await call("GET", "/v1/objects?type=rocket_body&limit=50");
    expect(a.statusCode).toBe(200);
    expect(a.json().items).toHaveLength(50);
    const b = await call("GET", `/v1/objects?type=rocket_body&limit=50&cursor=${a.json().nextCursor}`);
    expect(b.json().items[0].noradId).toBeGreaterThan(a.json().items[49].noradId);
    const fleet = await call("GET", "/v1/objects?operator=aurora&limit=100");
    expect(fleet.json().items).toHaveLength(60);
    const box = await call("GET", "/v1/objects?bbox=-180,-90,180,90&limit=5");
    expect(box.json().items).toHaveLength(5);
    expect((await call("GET", "/v1/objects?bbox=oops")).statusCode).toBe(400);
  });
  it("returns an object and its ephemeris, refuses huge requests", async () => {
    const o = await call("GET", "/v1/objects/70015", {}, undefined, "/v1/objects/{id}");
    expect(o.json().name).toBe("AURORA-205");
    expect(o.json().orbit.periodMin).toBeGreaterThan(90);
    const byUuid = await call("GET", `/v1/objects/${o.json().id}`, {}, undefined, "/v1/objects/{id}");
    expect(byUuid.json().noradId).toBe(70015);
    expect((await call("GET", "/v1/objects/1", {}, undefined, "/v1/objects/{id}")).statusCode).toBe(404);
    const e = await call("GET", "/v1/objects/70015/ephemeris?from=2026-10-06T00:00:00Z&to=2026-10-06T01:00:00Z&step=60", {}, undefined, "/v1/objects/{id}/ephemeris");
    expect(e.json().points).toHaveLength(61);
    expect(Math.hypot(...e.json().points[0].r)).toBeGreaterThan(6800);
    expect((await call("GET", "/v1/objects/70015/ephemeris?from=2026-10-06T00:00:00Z&to=2026-10-08T00:00:00Z&step=1", {}, undefined, "/v1/objects/{id}/ephemeris")).json().error.code).toBe("too_many_points");
    const p = await call("POST", "/v1/propagate", {}, { noradId: 70015, times: ["2026-10-06T00:00:00Z"] });
    expect(p.json().points[0].r[0]).toBeCloseTo(e.json().points[0].r[0], 6);
    expect((await call("POST", "/v1/propagate", {}, { times: ["2026-10-06T00:00:00Z"] })).statusCode).toBe(400);
  });
});

describe("authorization matrix and tenant isolation", () => {
  let highId = "";
  it("needs a token for tenant data; unknown tokens are rejected", async () => {
    expect((await call("GET", "/v1/conjunctions")).statusCode).toBe(401);
    expect((await call("GET", "/v1/conjunctions", { authorization: "Bearer nope" })).statusCode).toBe(401);
    const r = await call("GET", "/v1/conjunctions?risk=high", OP);
    expect(r.json().conjunctions).toHaveLength(1);
    highId = r.json().conjunctions[0].id;
    expect((await call("GET", "/v1/conjunctions", VIEW)).json().conjunctions.length).toBe(116);
  });
  it("another operator cannot see, plan against or guess Aurora's conjunctions", async () => {
    expect((await call("GET", "/v1/conjunctions", OTHER)).json().conjunctions).toHaveLength(0);
    expect((await call("GET", `/v1/conjunctions/${highId}`, OTHER, undefined, "/v1/conjunctions/{id}")).statusCode).toBe(404);
    expect((await call("GET", `/v1/conjunctions/${highId.slice(0, 8)}`, OTHER, undefined, "/v1/conjunctions/{id}")).statusCode).toBe(404);
    const plan = await call("POST", `/v1/conjunctions/${highId}/maneuver-scenarios`, { ...OTHER, "idempotency-key": "tenant-escape-1" }, {}, "/v1/conjunctions/{id}/maneuver-scenarios");
    expect(plan.statusCode).toBe(404);
  });
  it("row-level security holds even for a query with no WHERE clause", async () => {
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL ?? "postgresql://orbital_app:app-dev-only@127.0.0.1:55430/orbital" });
    await c.connect();
    expect((await c.query("SELECT count(*)::int n FROM conjunction_events")).rows[0].n).toBe(0); // no tenant set: nothing
    const lattice = (await c.query("SELECT id FROM organizations WHERE slug = 'lattice'")).rows[0].id;
    await c.query("BEGIN"); await c.query("SELECT set_config('app.tenant', $1, true)", [lattice]);
    expect((await c.query("SELECT count(*)::int n FROM conjunction_events")).rows[0].n).toBe(0);
    await expect(c.query("INSERT INTO alert_rules (id, tenant_id, rule) SELECT gen_random_uuid(), id, '{}' FROM organizations WHERE slug = 'aurora'")).rejects.toThrow(/row-level security/);
    await c.query("ROLLBACK"); await c.end();
  });
  it("viewers cannot change anything", async () => {
    const r = await call("POST", "/v1/alerts/rules", { ...VIEW, "idempotency-key": "viewer-rule-1" }, { name: "x", scope: "fleet", minPc: 1e-4, withinHours: 24, channel: "email", target: "a@b.co" });
    expect(r.statusCode).toBe(403);
  });
});

describe("mutations: idempotency, validation, audit", () => {
  const rule = { name: "High Pc on my fleet", scope: "fleet", minPc: 1e-4, withinHours: 24, channel: "email", target: "ops@aurora.example" };
  it("requires an Idempotency-Key, replays the same request, rejects a reused key with a different body", async () => {
    expect((await call("POST", "/v1/alerts/rules", OP, rule)).statusCode).toBe(400);
    const a = await call("POST", "/v1/alerts/rules", { ...OP, "idempotency-key": "rule-key-0001" }, rule);
    expect(a.statusCode).toBe(201);
    expect(a.json().deliveries).toHaveLength(1);
    expect(a.json().deliveries[0].text).toContain("AURORA-205");
    const b = await call("POST", "/v1/alerts/rules", { ...OP, "idempotency-key": "rule-key-0001" }, rule);
    expect(b.statusCode).toBe(201);
    expect(b.headers["idempotent-replayed"]).toBe("true");
    expect(a.json().rule.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.json().rule.scope).toBe("fleet");
    expect(b.json().rule.id).toBe(a.json().rule.id);
    expect((await call("GET", "/v1/alerts/rules", OP)).json().items).toHaveLength(1);
    expect((await call("GET", "/v1/alerts/rules", OP)).json().items[0].minPc).toBe(1e-4);
    expect((await call("POST", "/v1/alerts/rules", { ...OP, "idempotency-key": "rule-key-0001" }, { ...rule, minPc: 1e-5 })).statusCode).toBe(409);
    expect((await call("POST", "/v1/alerts/rules", { ...OP, "idempotency-key": "rule-key-0002" }, { ...rule, target: "not-an-email" })).json().error.code).toBe("invalid_rule");
    expect((await call("GET", "/v1/alerts/rules", OTHER)).json().items).toHaveLength(0);
  });
  it("plans avoidance burns through the API and records them", async () => {
    const id = (await call("GET", "/v1/conjunctions?risk=high", OP)).json().conjunctions[0].id;
    const r = await call("POST", `/v1/conjunctions/${id}/maneuver-scenarios`, { ...OP, "idempotency-key": "plan-key-0001" }, {}, "/v1/conjunctions/{id}/maneuver-scenarios");
    expect(r.statusCode).toBe(201);
    const j = r.json();
    expect(j.options).toHaveLength(2);
    expect(j.options[0].dvMs).toBeGreaterThan(0);
    expect(j.rejected[0].worst.pc).toBeGreaterThan(1e-6);
    expect(j.options.every((o: { safe: boolean; pc: number }) => o.safe && o.pc <= 1e-6)).toBe(true);
    expect(j.rejected.length).toBeGreaterThan(0);
    expect(j.maneuverIds).toHaveLength(j.options.length + j.rejected.length);
  }, 120_000);
  it("keeps a valid hash-chained audit log", async () => {
    const a = await call("GET", "/v1/audit", OP);
    expect((await call("GET", "/v1/ground-stations")).json().items[0].latDeg).toBeCloseTo(78.23);
    expect(a.json().items.map((x: { action: string }) => x.action)).toEqual(["alert_rule.create", "maneuver.plan"]);
    expect(a.json().chainValid).toBe(true);
    // keys in a different order hash the same (jsonb does not preserve order)
    const { canonical } = await import("../src/db.ts");
    expect(canonical({ b: 1, a: { d: [2, { y: 1, x: 0 }], c: null } })).toBe(canonical({ a: { c: null, d: [2, { x: 0, y: 1 }] }, b: 1 }));
    expect((await call("GET", "/v1/audit", OTHER)).json().items).toHaveLength(0);
  });
});

describe("operations", () => {
  it("simulated feed outage returns a structured 503", async () => {
    const r = await call("GET", "/v1/catalog/compact?simulate=outage");
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe("feed_unavailable");
    expect(r.json().error.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect((await call("GET", "/v1/catalog/compact")).json().objects).toHaveLength(18050);
  });
  it("propagates the caller's trace id and exposes RED metrics", async () => {
    const tp = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01";
    const r = await app.inject({ method: "GET", url: "/v1/ground-stations", headers: { traceparent: tp } });
    expect(String(r.headers.traceparent)).toContain("0123456789abcdef0123456789abcdef");
    const m = await app.inject({ method: "GET", url: "/metrics" });
    expect(m.body).toMatch(/orbital_request_latency_ms\{route="GET \/v1\/objects",quantile="0.95"\}/);
  });
  it("rate-limits per credential with headers", async () => {
    let last = 200;
    for (let i = 0; i < 60 && last !== 429; i++) last = (await app.inject({ method: "GET", url: "/v1/ground-stations", headers: { authorization: "Bearer aurora-viewer-demo" } })).statusCode;
    expect(last).toBe(429);
    const r = await app.inject({ method: "GET", url: "/v1/ground-stations", headers: { authorization: "Bearer aurora-viewer-demo" } });
    expect(r.headers["retry-after"]).toBeDefined();
    expect(r.headers["ratelimit-remaining"]).toBe("0");
  });
  it("streams live positions over WebSocket", async () => {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as { port: number }).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/live/objects`);
    const msg = await new Promise<{ t: string; objects: { norad: number; r: number[] }[] }>((ok, bad) => {
      ws.on("open", () => ws.send(JSON.stringify({ subscribe: [70015, 70016, 1] })));
      ws.on("message", (m: Buffer) => ok(JSON.parse(String(m))));
      setTimeout(() => bad(new Error("no message")), 4000);
    });
    ws.close();
    expect(msg.objects.map((o) => o.norad)).toEqual([70015, 70016]);
    expect(Math.hypot(...msg.objects[0].r)).toBeGreaterThan(6800);
  });
});
