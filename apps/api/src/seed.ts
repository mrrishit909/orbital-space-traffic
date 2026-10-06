// Loads the synthetic fixtures (data/fixtures, made by data/simulators/generate.ts) into Postgres as the owner. Idempotent:
// `make reset` truncates first. Demo tokens are local-only and printed in the README.
import { readFileSync } from "node:fs";
import pg from "pg";
import { GROUND_STATIONS, uuidFor } from "../../../packages/domain/src/index.ts";
import { sha256 } from "./db.ts";

export const ORGS = [
  { id: uuidFor(9, 1), slug: "aurora", name: "Aurora Constellation", plan: "operator_pro" },
  { id: uuidFor(9, 2), slug: "lattice", name: "Lattice Broadband", plan: "enterprise" },
] as const;
export const TOKENS = [
  { token: "aurora-operator-demo", org: "aurora", role: "operator" },
  { token: "aurora-viewer-demo", org: "aurora", role: "viewer" },
  { token: "lattice-operator-demo", org: "lattice", role: "operator" },
] as const;

export async function seed(url = process.env.OWNER_DATABASE_URL ?? "postgresql://orbital:owner-dev-only@127.0.0.1:55430/orbital", reset = false) {
  const fx = new URL("../../../data/fixtures/", import.meta.url);
  const cat = JSON.parse(readFileSync(new URL("catalog.json", fx), "utf8"));
  const cj = JSON.parse(readFileSync(new URL("conjunctions.json", fx), "utf8"));
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query("BEGIN");
  if (reset) await c.query("TRUNCATE alert_deliveries, alert_rules, maneuvers, conjunction_events, ephemeris_points, tle_sets, space_objects, ground_stations, api_tokens, idempotency_keys, audit_log, client_telemetry, organizations CASCADE");
  const have = (await c.query("SELECT count(*)::int AS n FROM space_objects")).rows[0].n;
  if (have > 0 && !reset) { await c.query("ROLLBACK"); await c.end(); console.log(JSON.stringify({ msg: "already seeded", objects: have })); return; }
  for (const o of ORGS) await c.query("INSERT INTO organizations (id, slug, name, plan) VALUES ($1,$2,$3,$4)", [o.id, o.slug, o.name, o.plan]);
  for (const t of TOKENS) await c.query("INSERT INTO api_tokens (token_sha256, organization_id, role, label) VALUES ($1,$2,$3,$4)", [sha256(t.token), ORGS.find((o) => o.slug === t.org)!.id, t.role, t.token]);
  const orgId = new Map<string, string>(ORGS.map((o) => [o.slug, o.id]));
  const opSlug = (i: number) => (i < 0 ? null : cat.operators[i].slug);
  // bulk insert in chunks with unnest
  const rows = cat.objects as [number, string, string, number, string, number, number, number, number, number, string, string][];
  for (let k = 0; k < rows.length; k += 2000) {
    const ch = rows.slice(k, k + 2000);
    await c.query(`INSERT INTO space_objects (id, norad_id, cospar_id, name, object_type, operator_org_id, status, mass_kg, radius_m, family, sigma_ric_m)
      SELECT u.id, u.norad, u.cospar, u.name, u.type, u.op, 'active', u.mass, u.radius, u.family, ARRAY[u.sr, u.si, u.sc]
      FROM unnest($1::uuid[], $2::bigint[], $3::text[], $4::text[], $5::text[], $6::uuid[], $7::numeric[], $8::numeric[], $9::text[], $10::float8[], $11::float8[], $12::float8[])
        AS u(id, norad, cospar, name, type, op, mass, radius, family, sr, si, sc)`,
      [ch.map((o) => uuidFor(1, o[0])), ch.map((o) => o[0]), ch.map((o) => o[10].slice(9, 17).trim()), ch.map((o) => o[1]), ch.map((o) => o[2]),
        ch.map((o) => (opSlug(o[3]) ? orgId.get(opSlug(o[3])) ?? null : null)), ch.map((o) => o[6]), ch.map((o) => o[5]), ch.map((o) => o[4]), ch.map((o) => o[7]), ch.map((o) => o[8]), ch.map((o) => o[9])]);
    await c.query(`INSERT INTO tle_sets (id, space_object_id, epoch, line1, line2, source)
      SELECT u.id, u.obj, $4::timestamptz, u.l1, u.l2, 'synthetic:catalog-v1' FROM unnest($1::uuid[], $2::uuid[], $3::text[], $5::text[]) AS u(id, obj, l1, l2)`,
      [ch.map((o) => uuidFor(2, o[0])), ch.map((o) => uuidFor(1, o[0])), ch.map((o) => o[10]), cat.epoch, ch.map((o) => o[11])]);
  }
  const aurora = orgId.get("aurora")!;
  for (const x of cj.conjunctions)
    await c.query(`INSERT INTO conjunction_events (id, tenant_id, primary_object_id, secondary_object_id, tca, miss_distance_m, relative_velocity_mps, collision_probability, risk_level, geometry)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [x.id, aurora, uuidFor(1, x.primaryNorad), uuidFor(1, x.secondaryNorad), x.tca, x.missM, x.relSpeedMs, x.pc, x.risk,
      { hbrM: x.hbrM, sigmaPlaneM: x.sigmaPlaneM, covKm2: x.covKm2, rPrimary: x.rPrimary, vPrimary: x.vPrimary, rSecondary: x.rSecondary, vSecondary: x.vSecondary }]);
  for (const g of GROUND_STATIONS) await c.query("INSERT INTO ground_stations VALUES ($1,$2,$3,$4,$5,$6)", [g.id, g.name, g.latDeg, g.lonDeg, g.altKm, g.minElevDeg]);
  await c.query("COMMIT");
  await c.end();
  console.log(JSON.stringify({ msg: "seeded", objects: rows.length, conjunctions: cj.conjunctions.length }));
}

if (import.meta.url === `file://${process.argv[1]}`) await seed(undefined, process.argv.includes("--reset"));
