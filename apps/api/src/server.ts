// ORBITAL API (one Fastify process standing in for the blueprint's gateway, catalog, ephemeris, propagation, conjunction,
// maneuver-simulation, alert and identity services; see README "Not built" for why it is one process).
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import websocket from "@fastify/websocket";
import swagger from "@fastify/swagger";
import { randomBytes } from "node:crypto";
import nodemailer from "nodemailer";
import type { SatRec } from "satellite.js";
import { eciToGeodetic, gstime } from "satellite.js";
import {
  GROUND_STATIONS, demoWindow, matches, notificationText, parse, planWithRescreen, shellOf, stateAt, validateRule, uuidFor,
  type AlertRule, type BatchPropagator, type Conjunction,
} from "../../../packages/domain/src/index.ts";
import { wasmBatch } from "../../../packages/domain/src/wasm.ts";
import { audit, pool, sha256, withTenant } from "./db.ts";

interface Auth { org: string; slug: string; role: "viewer" | "operator" | "admin"; label: string }
declare module "fastify" { interface FastifyRequest { auth?: Auth; traceId: string; t0: bigint } }

class ApiError extends Error {
  status: number; code: string; details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) { super(message); this.status = status; this.code = code; this.details = details; }
}

const err = (status: number, code: string) => ({ type: "object", properties: { error: { type: "object", properties: { code: { type: "string", const: code }, message: { type: "string" }, traceId: { type: "string" } }, required: ["code", "message"] } } });
const Err = { type: "object", properties: { error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" }, traceId: { type: "string" }, details: {} }, required: ["code", "message"] } }, required: ["error"] };
const V3 = { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 };
const SpaceObject = { type: "object", required: ["id", "noradId", "name", "objectType"], properties: { id: { type: "string", format: "uuid" }, noradId: { type: "integer" }, cosparId: { type: "string" }, name: { type: "string" }, objectType: { type: "string", enum: ["payload", "rocket_body", "debris", "unknown"] }, operator: { type: ["string", "null"] }, massKg: { type: "number" }, radiusM: { type: "number" }, family: { type: "string" } } };
const ConjunctionS = { type: "object", required: ["id", "primaryNorad", "secondaryNorad", "tca", "missM", "pc", "risk"], properties: { id: { type: "string" }, primaryNorad: { type: "integer" }, secondaryNorad: { type: "integer" }, tca: { type: "string", format: "date-time" }, missM: { type: "number" }, relSpeedMs: { type: "number" }, pc: { type: "number" }, risk: { type: "string", enum: ["high", "medium", "low"] }, hbrM: { type: "number" }, sigmaPlaneM: { type: "array", items: { type: "number" } }, covKm2: { type: "array", items: { type: "array", items: { type: "number" } } }, rPrimary: V3, vPrimary: V3, rSecondary: V3, vSecondary: V3 } };
const Page = (item: object) => ({ type: "object", required: ["items"], properties: { items: { type: "array", items: item }, nextCursor: { type: ["string", "null"] } } });
const Rule = { type: "object", required: ["name", "scope", "minPc", "withinHours", "channel", "target"], properties: { name: { type: "string", maxLength: 80 }, scope: { description: "\"fleet\" or a list of NORAD ids (checked by validateRule; a oneOf here would be mangled by type coercion)" }, minPc: { type: "number" }, maxMissM: { type: "number" }, withinHours: { type: "number" }, channel: { type: "string", enum: ["email", "webhook"] }, target: { type: "string" } } };
const idemHeader = { type: "object", properties: { "idempotency-key": { type: "string", minLength: 8, maxLength: 128 } }, required: ["idempotency-key"] };
const sec = [{ bearer: [] }];

export interface Catalog { epoch: string; sats: SatRec[]; norads: number[]; objects: { id: string; norad: number; name: string; type: string; operator: string | null; family: string; radiusM: number; massKg: number; sigma: [number, number, number]; l1: string; l2: string; cospar: string }[]; byNorad: Map<number, number>; compact: unknown }

export async function loadCatalog(): Promise<Catalog> {
  const r = await pool.query(`SELECT o.id, o.norad_id, o.cospar_id, o.name, o.object_type, org.slug AS operator, o.family, o.radius_m, o.mass_kg, o.sigma_ric_m, t.line1, t.line2, t.epoch
    FROM space_objects o JOIN LATERAL (SELECT line1, line2, epoch FROM tle_sets WHERE space_object_id = o.id ORDER BY epoch DESC LIMIT 1) t ON true
    LEFT JOIN organizations org ON org.id = o.operator_org_id ORDER BY o.norad_id`);
  const objects = r.rows.map((x) => ({ id: x.id, norad: Number(x.norad_id), name: x.name, type: x.object_type, operator: x.operator, family: x.family, radiusM: Number(x.radius_m), massKg: Number(x.mass_kg), sigma: x.sigma_ric_m as [number, number, number], l1: x.line1, l2: x.line2, cospar: x.cospar_id }));
  const epoch = r.rows[0] ? new Date(r.rows[0].epoch).toISOString() : new Date().toISOString();
  const ops = [...new Set(objects.map((o) => o.operator).filter(Boolean))] as string[];
  const compact = { version: "catalog-v1", seed: 0, epoch, operators: ops.map((slug) => ({ slug, name: slug })), planted: [], fields: [],
    objects: objects.map((o) => [o.norad, o.name, o.type, o.operator ? ops.indexOf(o.operator) : -1, o.family, o.radiusM, o.massKg, ...o.sigma, o.l1, o.l2]) };
  return { epoch, objects, sats: objects.map((o) => parse(o.l1, o.l2)), norads: objects.map((o) => o.norad), byNorad: new Map(objects.map((o, i) => [o.norad, i])), compact };
}

const rowToConjunction = (x: Record<string, unknown>, cat: Catalog): Conjunction => {
  const g = x.geometry as Record<string, unknown>;
  return { id: x.id as string, primaryNorad: Number(x.primary_norad), secondaryNorad: Number(x.secondary_norad), tca: new Date(x.tca as string).toISOString(), missM: Number(x.miss_distance_m), relSpeedMs: Number(x.relative_velocity_mps),
    pc: Number(x.collision_probability), risk: x.risk_level as Conjunction["risk"], ...(g as object) } as Conjunction & { hbrM: number };
};
const CJ_SELECT = `SELECT c.*, p.norad_id AS primary_norad, s.norad_id AS secondary_norad FROM conjunction_events c JOIN space_objects p ON p.id = c.primary_object_id JOIN space_objects s ON s.id = c.secondary_object_id`;

/** Simple token bucket per credential (or IP for anonymous calls). Headers follow the IETF RateLimit draft names. */
function limiter(capacity: number, perSec: number) {
  const b = new Map<string, { tokens: number; at: number }>();
  return (key: string) => {
    const now = Date.now(), s = b.get(key) ?? { tokens: capacity, at: now };
    s.tokens = Math.min(capacity, s.tokens + ((now - s.at) / 1000) * perSec); s.at = now;
    const ok = s.tokens >= 1;
    if (ok) s.tokens -= 1;
    b.set(key, s);
    return { ok, remaining: Math.floor(s.tokens), resetS: Math.ceil((capacity - s.tokens) / perSec) };
  };
}

export async function build(opts: { catalog?: Catalog; rateLimit?: number; mail?: { host: string; port: number } | null; logger?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger ?? true, genReqId: () => randomBytes(8).toString("hex"), bodyLimit: 256 * 1024 });
  const cat = opts.catalog ?? (await loadCatalog());
  const win = demoWindow(cat.epoch);
  let batch: BatchPropagator | undefined;
  try { batch = await wasmBatch(); } catch { batch = undefined; }
  const limit = limiter(opts.rateLimit ?? 120, (opts.rateLimit ?? 120) / 60);
  const mailer = opts.mail === null ? null : nodemailer.createTransport({ host: opts.mail?.host ?? process.env.MAIL_HOST ?? "127.0.0.1", port: opts.mail?.port ?? Number(process.env.MAIL_PORT ?? 1025), secure: false });
  const metrics = new Map<string, { n: number; errors: number; lat: number[] }>();
  let wsClients = 0;

  await app.register(swagger, {
    openapi: { openapi: "3.1.0", info: { title: "ORBITAL API", version: "1.0.0", description: "Space-traffic sandbox API on a synthetic catalog. Mutations need an Idempotency-Key header. Errors are {error:{code,message,traceId}}. Lists are paginated with ?limit and ?cursor (nextCursor)." },
      components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } }, servers: [{ url: "http://localhost:8430" }] },
  });
  await app.register(websocket);

  // ---- cross-cutting: trace context, auth, rate limit, CORS, security headers, metrics ----
  app.addHook("onRequest", async (req, reply) => {
    req.t0 = process.hrtime.bigint();
    const tp = String(req.headers.traceparent ?? "");
    const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-0[01]$/.exec(tp);
    req.traceId = m ? m[1] : randomBytes(16).toString("hex");
    reply.header("traceparent", `00-${req.traceId}-${randomBytes(8).toString("hex")}-01`);
    reply.header("x-content-type-options", "nosniff").header("referrer-policy", "no-referrer").header("cache-control", "no-store");
    const origin = String(req.headers.origin ?? "");
    const allowed = (process.env.CORS_ORIGINS ?? "http://localhost:8431,http://127.0.0.1:8431,http://localhost:3000").split(",");
    if (allowed.includes(origin)) reply.header("access-control-allow-origin", origin).header("vary", "origin").header("access-control-allow-headers", "authorization,content-type,idempotency-key,traceparent").header("access-control-expose-headers", "traceparent,ratelimit-limit,ratelimit-remaining,ratelimit-reset");
    if (req.method === "OPTIONS") return reply.code(204).send();
    const h = String(req.headers.authorization ?? "");
    if (h.startsWith("Bearer ")) {
      const r = await pool.query("SELECT t.role, t.label, o.id, o.slug FROM api_tokens t JOIN organizations o ON o.id = t.organization_id WHERE t.token_sha256 = $1", [sha256(h.slice(7))]);
      if (!r.rows[0]) throw new ApiError(401, "unauthenticated", "unknown token");
      req.auth = { org: r.rows[0].id, slug: r.rows[0].slug, role: r.rows[0].role, label: r.rows[0].label };
    }
    const rl = limit(req.auth?.label ?? req.ip);
    reply.header("ratelimit-limit", opts.rateLimit ?? 120).header("ratelimit-remaining", rl.remaining).header("ratelimit-reset", rl.resetS);
    if (!rl.ok) { reply.header("retry-after", rl.resetS); throw new ApiError(429, "rate_limited", "too many requests"); }
  });
  app.addHook("onResponse", async (req, reply) => {
    const route = `${req.method} ${req.routeOptions.url ?? "unmatched"}`;
    const m = metrics.get(route) ?? { n: 0, errors: 0, lat: [] };
    m.n++; if (reply.statusCode >= 500) m.errors++;
    m.lat.push(Number(process.hrtime.bigint() - req.t0) / 1e6); if (m.lat.length > 2000) m.lat.shift();
    metrics.set(route, m);
    req.log.info({ traceId: req.traceId, route, status: reply.statusCode, tenant: req.auth?.slug }, "request");
  });
  app.setErrorHandler((e: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    if (e instanceof ApiError) return reply.code(e.status).send({ error: { code: e.code, message: e.message, traceId: req.traceId, details: e.details } });
    if (e.validation) return reply.code(400).send({ error: { code: "invalid_request", message: e.message, traceId: req.traceId } });
    req.log.error({ err: e, traceId: req.traceId }, "unhandled");
    return reply.code(e.statusCode && e.statusCode < 500 ? e.statusCode : 500).send({ error: { code: "internal", message: e.statusCode && e.statusCode < 500 ? e.message : "internal error", traceId: req.traceId } });
  });

  const need = (req: FastifyRequest, role?: "operator"): Auth => {
    if (!req.auth) throw new ApiError(401, "unauthenticated", "Bearer token required");
    if (role && req.auth.role === "viewer") throw new ApiError(403, "forbidden", "viewer tokens cannot change anything");
    return req.auth;
  };
  /** Idempotency: same key + same body replays the stored response; same key + different body is a conflict. */
  async function idempotent(req: FastifyRequest, reply: FastifyReply, run: () => Promise<{ status: number; body: unknown }>) {
    const a = need(req, "operator");
    const key = String(req.headers["idempotency-key"]);
    const hash = sha256(JSON.stringify(req.body ?? null));
    const prior = await withTenant(a.org, (c) => c.query("SELECT request_sha256, status, response FROM idempotency_keys WHERE key = $1", [key]));
    if (prior.rows[0]) {
      if (prior.rows[0].request_sha256 !== hash) throw new ApiError(409, "idempotency_conflict", "this Idempotency-Key was used with a different request");
      return reply.code(prior.rows[0].status).header("idempotent-replayed", "true").send(prior.rows[0].response);
    }
    const out = await run();
    await withTenant(a.org, (c) => c.query("INSERT INTO idempotency_keys (tenant_id, key, method, path, request_sha256, status, response) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING",
      [a.org, key, req.method, req.url, hash, out.status, out.body]));
    return reply.code(out.status).send(out.body);
  }
  const objIdx = (id: string) => {
    const i = /^\d+$/.test(id) ? cat.byNorad.get(Number(id)) : cat.objects.findIndex((o) => o.id === id);
    if (i === undefined || i < 0) throw new ApiError(404, "not_found", `no object ${id}`);
    return i;
  };
  const objOut = (i: number) => { const o = cat.objects[i]; return { id: o.id, noradId: o.norad, cosparId: o.cospar, name: o.name, objectType: o.type, operator: o.operator, massKg: o.massKg, radiusM: o.radiusM, family: o.family }; };

  // ---- routes ----
  app.get("/healthz", { schema: { hide: true } }, async () => { await pool.query("SELECT 1"); return { ok: true, objects: cat.objects.length, wasm: !!batch }; });
  app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());
  app.get("/metrics", { schema: { hide: true } }, async (_, reply) => {
    const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
    const lines = ["# TYPE orbital_requests_total counter", "# TYPE orbital_request_errors_total counter", "# TYPE orbital_request_latency_ms summary"];
    for (const [r, m] of metrics) {
      const l = `route="${r}"`;
      lines.push(`orbital_requests_total{${l}} ${m.n}`, `orbital_request_errors_total{${l}} ${m.errors}`);
      for (const p of [0.5, 0.95, 0.99]) lines.push(`orbital_request_latency_ms{${l},quantile="${p}"} ${q(m.lat, p).toFixed(2)}`);
    }
    lines.push(`orbital_db_pool_total ${pool.totalCount}`, `orbital_db_pool_idle ${pool.idleCount}`, `orbital_db_pool_waiting ${pool.waitingCount}`, `orbital_ws_subscriptions ${wsClients}`);
    return reply.type("text/plain; version=0.0.4").send(lines.join("\n") + "\n");
  });

  app.get("/v1/catalog/compact", { schema: { tags: ["catalog"], summary: "Whole catalog in the compact form the web app loads (public)", querystring: { type: "object", properties: { simulate: { type: "string", enum: ["outage"] } } } } }, async (req) => {
    if ((req.query as { simulate?: string }).simulate === "outage" || process.env.FAIL_FEED === "1") throw new ApiError(503, "feed_unavailable", "element-set feed unavailable (simulated outage)");
    return cat.compact;
  });

  app.get("/v1/objects", {
    schema: { tags: ["catalog"], summary: "List objects; bbox filters by sub-satellite point at time `at`", querystring: { type: "object", properties: { type: { type: "string", enum: ["payload", "rocket_body", "debris", "unknown"] }, operator: { type: "string" }, bbox: { type: "string", pattern: "^-?[\\d.]+,-?[\\d.]+,-?[\\d.]+,-?[\\d.]+$" }, at: { type: "string", format: "date-time" }, limit: { type: "integer", minimum: 1, maximum: 1000, default: 100 }, cursor: { type: "string" } } },
      response: { 200: Page(SpaceObject), 400: Err } },
  }, async (req) => {
    const q = req.query as { type?: string; operator?: string; bbox?: string; at?: string; limit: number; cursor?: string };
    const after = q.cursor ? Number(Buffer.from(q.cursor, "base64url").toString()) : 0;
    const at = q.at ? new Date(q.at) : new Date(win.now);
    const box = q.bbox?.split(",").map(Number);
    const out: number[] = [];
    for (let i = 0; i < cat.objects.length && out.length <= q.limit; i++) {
      const o = cat.objects[i];
      if (o.norad <= after || (q.type && o.type !== q.type) || (q.operator && o.operator !== q.operator)) continue;
      if (box) {
        const s = stateAt(cat.sats[i], at); if (!s) continue;
        const g = eciToGeodetic({ x: s.r[0], y: s.r[1], z: s.r[2] }, gstime(at)), lon = (g.longitude * 180) / Math.PI, lat = (g.latitude * 180) / Math.PI;
        if (lon < box[0] || lat < box[1] || lon > box[2] || lat > box[3]) continue;
      }
      out.push(i);
    }
    const more = out.length > q.limit, items = out.slice(0, q.limit).map(objOut);
    return { items, nextCursor: more ? Buffer.from(String(items.at(-1)!.noradId)).toString("base64url") : null };
  });

  app.get("/v1/objects/:id", { schema: { tags: ["catalog"], params: { type: "object", properties: { id: { type: "string" } } }, response: { 200: { type: "object", properties: { ...SpaceObject.properties, tle: { type: "object", properties: { line1: { type: "string" }, line2: { type: "string" }, epoch: { type: "string" } } }, orbit: { type: "object", properties: { perigeeKm: { type: "number" }, apogeeKm: { type: "number" }, inclinationDeg: { type: "number" }, periodMin: { type: "number" } } } } }, 404: Err } } }, async (req) => {
    const i = objIdx((req.params as { id: string }).id), s = cat.sats[i], sh = shellOf(s);
    return { ...objOut(i), tle: { line1: cat.objects[i].l1, line2: cat.objects[i].l2, epoch: cat.epoch }, orbit: { perigeeKm: sh.perigeeKm, apogeeKm: sh.apogeeKm, inclinationDeg: (s.inclo * 180) / Math.PI, periodMin: (2 * Math.PI) / s.no } };
  });

  app.get("/v1/objects/:id/ephemeris", { schema: { tags: ["ephemeris"], summary: "TEME states from SGP4 (max 2,000 points)", params: { type: "object", properties: { id: { type: "string" } } }, querystring: { type: "object", required: ["from", "to"], properties: { from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" }, step: { type: "integer", minimum: 1, maximum: 86400, default: 60 } } }, response: { 200: { type: "object", properties: { frame: { type: "string" }, points: { type: "array", items: { type: "object", properties: { t: { type: "string" }, r: V3, v: V3 } } } } }, 400: Err, 404: Err } } }, async (req) => {
    const i = objIdx((req.params as { id: string }).id);
    const q = req.query as { from: string; to: string; step: number };
    const a = Date.parse(q.from), b = Date.parse(q.to);
    if (!(b > a)) throw new ApiError(400, "invalid_request", "`to` must be after `from`");
    if ((b - a) / 1000 / q.step > 2000) throw new ApiError(400, "too_many_points", "at most 2,000 points per request; raise `step` or page by time");
    const points = [];
    for (let t = a; t <= b; t += q.step * 1000) { const s = stateAt(cat.sats[i], new Date(t)); if (s) points.push({ t: new Date(t).toISOString(), r: s.r, v: s.v }); }
    return { frame: "TEME", points };
  });

  app.post("/v1/propagate", { schema: { tags: ["ephemeris"], summary: "Propagate a catalog object or an arbitrary TLE to given times", body: { type: "object", properties: { noradId: { type: "integer" }, line1: { type: "string", minLength: 69, maxLength: 69 }, line2: { type: "string", minLength: 69, maxLength: 69 }, times: { type: "array", items: { type: "string", format: "date-time" }, minItems: 1, maxItems: 1000 } }, required: ["times"] }, response: { 200: { type: "object", properties: { points: { type: "array", items: { type: "object", properties: { t: { type: "string" }, r: { type: ["array", "null"], items: { type: "number" } }, v: { type: ["array", "null"], items: { type: "number" } } } } } } }, 400: Err, 404: Err } } }, async (req) => {
    const b = req.body as { noradId?: number; line1?: string; line2?: string; times: string[] };
    let sat: SatRec;
    if (b.line1 && b.line2) { sat = parse(b.line1, b.line2); if (sat.error) throw new ApiError(400, "invalid_tle", "element set rejected by SGP4"); }
    else if (b.noradId) sat = cat.sats[objIdx(String(b.noradId))];
    else throw new ApiError(400, "invalid_request", "give noradId or line1 + line2");
    return { points: b.times.map((t) => { const s = stateAt(sat, new Date(t)); return { t, r: s?.r ?? null, v: s?.v ?? null }; }) };
  });

  app.get("/v1/conjunctions", { schema: { tags: ["conjunctions"], security: sec, querystring: { type: "object", properties: { from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" }, risk: { type: "string", enum: ["high", "medium", "low"] }, full: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 500, default: 500 }, cursor: { type: "string" } } }, response: { 200: { type: "object", properties: { epoch: { type: "string" }, conjunctions: { type: "array", items: ConjunctionS }, nextCursor: { type: ["string", "null"] } } }, 401: Err } } }, async (req) => {
    const a = need(req);
    const q = req.query as { from?: string; to?: string; risk?: string; limit: number; cursor?: string };
    const after = q.cursor ? Buffer.from(q.cursor, "base64url").toString() : "1970-01-01T00:00:00Z";
    const r = await withTenant(a.org, (c) => c.query(`${CJ_SELECT} WHERE c.tca > $1 AND ($2::timestamptz IS NULL OR c.tca >= $2) AND ($3::timestamptz IS NULL OR c.tca <= $3) AND ($4::text IS NULL OR c.risk_level = $4) ORDER BY c.tca LIMIT $5`,
      [after, q.from ?? null, q.to ?? null, q.risk ?? null, q.limit + 1]));
    const rows = r.rows.slice(0, q.limit).map((x) => rowToConjunction(x, cat));
    return { epoch: cat.epoch, conjunctions: rows, nextCursor: r.rows.length > q.limit ? Buffer.from(rows.at(-1)!.tca).toString("base64url") : null };
  });

  const getConj = async (org: string, id: string) => {
    if (!/^[0-9a-f-]{8,36}$/.test(id)) throw new ApiError(400, "invalid_request", "bad id");
    const r = await withTenant(org, (c) => c.query(`${CJ_SELECT} WHERE c.id::text LIKE $1 || '%' LIMIT 2`, [id]));
    if (r.rows.length !== 1) throw new ApiError(404, "not_found", `no conjunction ${id}`); // another tenant's rows are invisible, so they 404 too
    return rowToConjunction(r.rows[0], cat);
  };
  app.get("/v1/conjunctions/:id", { schema: { tags: ["conjunctions"], security: sec, params: { type: "object", properties: { id: { type: "string" } } }, response: { 200: ConjunctionS, 401: Err, 404: Err } } }, async (req) => getConj(need(req).org, (req.params as { id: string }).id));

  app.post("/v1/conjunctions/:id/maneuver-scenarios", { schema: { tags: ["maneuvers"], security: sec, summary: "Plan avoidance burns (simulation only) and re-screen each new orbit", headers: idemHeader, params: { type: "object", properties: { id: { type: "string" } } }, body: { type: "object", properties: { targetPc: { type: "number", minimum: 1e-9, maximum: 1e-3 }, notBefore: { type: "string", format: "date-time" } } }, response: { 201: { type: "object", properties: { conjunctionId: { type: "string" }, options: { type: "array", items: { type: "object", additionalProperties: true } }, rejected: { type: "array", items: { type: "object", additionalProperties: true } }, frontier: { type: "integer" }, maneuverIds: { type: "array", items: { type: "string" } } } }, 400: Err, 401: Err, 403: Err, 404: Err, 409: Err } } }, async (req, reply) =>
    idempotent(req, reply, async () => {
      const a = need(req, "operator");
      const c = await getConj(a.org, (req.params as { id: string }).id);
      const body = (req.body ?? {}) as { notBefore?: string };
      const i = cat.byNorad.get(c.primaryNorad)!;
      const r = planWithRescreen({ sats: cat.sats, meta: cat.objects.map((o) => ({ radiusM: o.radiusM, sigma: o.sigma })), norads: cat.norads, epoch: Date.parse(cat.epoch), conjunction: c, notBefore: new Date(body.notBefore ?? win.now), massKg: cat.objects[i].massKg, batch });
      const ids: string[] = [];
      await withTenant(a.org, async (db) => {
        for (const o of [...r.options, ...r.rejected]) {
          const id = uuidFor(5, Number.parseInt(sha256(`${c.id}:${o.burn}:${o.dvMs}`).slice(0, 7), 16));
          ids.push(id);
          await db.query(`INSERT INTO maneuvers (id, tenant_id, space_object_id, conjunction_id, burn_time, dv_x, dv_y, dv_z, simulation_only, status, result, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9,$10,$11) ON CONFLICT (id) DO NOTHING`,
            [id, a.org, cat.objects[i].id, c.id, o.burn, ...o.dvRicMs, o.safe ? "proposed" : "rejected", { missKm: o.missKm, pc: o.pc, worst: o.worst, newApproaches: o.newApproaches.length }, a.label]);
        }
        await audit(db, a.org, a.label, "maneuver.plan", c.id, { options: r.options.length, rejected: r.rejected.length }, req.traceId);
      });
      return { status: 201, body: { conjunctionId: c.id, ...r, maneuverIds: ids } };
    }));

  app.post("/v1/alerts/rules", { schema: { tags: ["alerts"], security: sec, headers: idemHeader, body: Rule, response: { 201: { type: "object", properties: { rule: { type: "object", additionalProperties: true, properties: { id: { type: "string" }, createdAt: { type: "string" } } }, deliveries: { type: "array", items: { type: "object", additionalProperties: true } } } }, 400: Err, 401: Err, 403: Err, 409: Err } } }, async (req, reply) =>
    idempotent(req, reply, async () => {
      const a = need(req, "operator");
      const rule = req.body as AlertRule;
      const errors = validateRule(rule);
      if (errors.length) throw new ApiError(400, "invalid_rule", errors.join("; "), errors);
      const id = uuidFor(6, Number.parseInt(sha256(String(req.headers["idempotency-key"])).slice(0, 7), 16));
      const saved = { ...rule, id, createdAt: new Date().toISOString() };
      const deliveries: { ruleId: string; channel: string; target: string; text: string; delivered: string; at: string }[] = [];
      await withTenant(a.org, async (db) => {
        await db.query("INSERT INTO alert_rules (id, tenant_id, rule, created_by) VALUES ($1,$2,$3,$4)", [id, a.org, rule, a.label]);
        const cs = (await db.query(CJ_SELECT)).rows.map((x) => rowToConjunction(x, cat));
        const fleet = new Set(cat.objects.filter((o) => o.operator === a.slug).map((o) => o.norad));
        const names = new Map(cat.objects.map((o) => [o.norad, o.name]));
        for (const c of matches(rule, cs, fleet, new Date(win.now))) {
          const text = notificationText(rule, c, names);
          let status = "queued";
          if (rule.channel === "email" && mailer) {
            try { await mailer.sendMail({ from: "alerts@orbital.local", to: rule.target, subject: `Conjunction alert: ${names.get(c.primaryNorad)} (${c.risk})`, text }); status = "smtp-sink"; }
            catch (e) { status = "failed"; req.log.warn({ err: e, traceId: req.traceId }, "mail sink unreachable"); }
          }
          await db.query("INSERT INTO alert_deliveries (tenant_id, rule_id, conjunction_id, channel, target, text, status) VALUES ($1,$2,$3,$4,$5,$6,$7)", [a.org, id, c.id, rule.channel, rule.target, text, status]);
          deliveries.push({ ruleId: id, channel: rule.channel, target: rule.target, text, delivered: status, at: new Date().toISOString() });
        }
        await audit(db, a.org, a.label, "alert_rule.create", id, { matches: deliveries.length }, req.traceId);
      });
      return { status: 201, body: { rule: saved, deliveries } };
    }));

  app.get("/v1/alerts/rules", { schema: { tags: ["alerts"], security: sec, response: { 200: { type: "object", properties: { items: { type: "array", items: { type: "object", additionalProperties: true } } } }, 401: Err } } }, async (req) => {
    const a = need(req);
    const r = await withTenant(a.org, (c) => c.query("SELECT id, rule, created_at FROM alert_rules WHERE deleted_at IS NULL ORDER BY created_at"));
    return { items: r.rows.map((x) => ({ id: x.id, ...x.rule, createdAt: x.created_at })) };
  });

  app.get("/v1/audit", { schema: { tags: ["admin"], security: sec, response: { 200: { type: "object", properties: { items: { type: "array", items: { type: "object", additionalProperties: true } }, chainValid: { type: "boolean" } } }, 401: Err } } }, async (req) => {
    const a = need(req);
    const r = await withTenant(a.org, (c) => c.query("SELECT tenant_id, actor, action, target, detail, prev_hash, hash, at FROM audit_log ORDER BY id"));
    let prev = "genesis", ok = true;
    for (const x of r.rows) { if (x.prev_hash !== prev || sha256(prev + JSON.stringify({ tenant: x.tenant_id, actor: x.actor, action: x.action, target: x.target, detail: x.detail })) !== x.hash) ok = false; prev = x.hash; }
    return { items: r.rows.map((x) => ({ actor: x.actor, action: x.action, target: x.target, at: x.at })), chainValid: ok };
  });

  app.get("/v1/ground-stations", { schema: { tags: ["catalog"], response: { 200: { type: "object", properties: { items: { type: "array", items: { type: "object", additionalProperties: true } } } } } } }, async () => ({ items: GROUND_STATIONS }));

  app.post("/v1/telemetry", { schema: { hide: true } }, async (req, reply) => {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    if (!body || typeof body !== "object") throw new ApiError(400, "invalid_request", "telemetry sample must be an object");
    await pool.query("INSERT INTO client_telemetry (sample) VALUES ($1)", [body]);
    return reply.code(204).send();
  });

  // live positions: subscribe with {"subscribe":[norad,...]} (max 200); the server pushes every second on the demo clock
  app.get("/v1/live/objects", { websocket: true, schema: { hide: true } }, (socket) => {
    wsClients++;
    const start = Date.now();
    let subs: number[] = [];
    socket.on("message", (m: Buffer) => {
      try { const j = JSON.parse(String(m)); if (Array.isArray(j.subscribe)) subs = j.subscribe.filter((n: unknown) => cat.byNorad.has(Number(n))).slice(0, 200).map(Number); }
      catch { socket.send(JSON.stringify({ error: { code: "invalid_message", message: "send {\"subscribe\":[norad,...]}" } })); }
    });
    const iv = setInterval(() => {
      if (!subs.length) return;
      const t = new Date(win.now + (Date.now() - start));
      socket.send(JSON.stringify({ t: t.toISOString(), objects: subs.map((n) => { const s = stateAt(cat.sats[cat.byNorad.get(n)!], t); return { norad: n, r: s?.r ?? null, v: s?.v ?? null }; }) }));
    }, 1000);
    socket.on("close", () => { clearInterval(iv); wsClients--; });
  });

  app.addHook("onClose", async () => { (batch as unknown as { dispose?: () => void })?.dispose?.(); });
  return app;
}

export { err };
