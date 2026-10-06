import { describe, expect, it } from "vitest";
import {
  generateCatalog, parse, toTle, checksum, expField, stateAt, satEpoch, screen, bruteForce, matchEncounters, jsBatch, shellOf, shellsOverlap,
  pc2d, pcMonteCarlo, encounterPlane, covEci, sigmaAt, riskLevel, planManeuvers, twoOptions, evaluateBurn, burnOffsets, burnedPath, rk4,
  toConjunction, passes, elevationDeg, GROUND_STATIONS, validateRule, matches, notificationText, hermite, demoWindow, relTime, clamp,
  kmToM, mToKm, smaFromMeanMotion, meanMotionFromSma, revPerDayToRadPerSec, radPerSecToRevPerDay, solve, brentMin, norm, sub, MU, rng, uuidFor,
  screenPath, type V3, type AlertRule,
} from "../src/index.ts";
import { wasmBatch } from "../src/wasm.ts";

const cat = generateCatalog();
const epoch = new Date(cat.epoch);
const sats = cat.objects.map((o) => parse(o.l1, o.l2));
const idx = (norad: number) => cat.objects.findIndex((o) => o.norad === norad);

describe("units and math", () => {
  it("round-trips unit conversions", () => {
    const r = rng(1);
    for (let i = 0; i < 200; i++) {
      const x = r.range(-1e5, 1e5);
      expect(mToKm(kmToM(x))).toBeCloseTo(x, 9);
      const n = r.range(0.5, 16);
      expect(meanMotionFromSma(smaFromMeanMotion(n))).toBeCloseTo(n, 9);
      expect(radPerSecToRevPerDay(revPerDayToRadPerSec(n))).toBeCloseTo(n, 12);
    }
    expect(smaFromMeanMotion(15.05)).toBeGreaterThan(6900);
  });
  it("solves linear systems and finds minima", () => {
    expect(solve([[2, 1], [1, 3]], [3, 5]).map((x) => +x.toFixed(9))).toEqual([0.8, 1.4]);
    expect(() => solve([[1, 2], [2, 4]], [1, 2])).toThrow();
    expect(brentMin((x) => (x - 1.234) ** 2 + 5, -10, 10, 1e-10).x).toBeCloseTo(1.234, 6);
    expect(brentMin((x) => Math.abs(x + 3), -10, 10, 1e-10).x).toBeCloseTo(-3, 5);
  });
  it("hermite interpolation: exact for straight lines, hits endpoints (property test)", () => {
    const r = rng(2);
    for (let i = 0; i < 300; i++) {
      const p0: V3 = [r.range(-7000, 7000), r.range(-7000, 7000), r.range(-7000, 7000)], v: V3 = [r.range(-8, 8), r.range(-8, 8), r.range(-8, 8)];
      const dt = r.range(1, 120), f = r.u();
      const p1: V3 = [p0[0] + v[0] * dt, p0[1] + v[1] * dt, p0[2] + v[2] * dt];
      const h = hermite(p0, v, p1, v, dt, f);
      for (let k = 0; k < 3; k++) expect(h[k]).toBeCloseTo(p0[k] + v[k] * dt * f, 6);
      expect(hermite(p0, v, p1, v, dt, 0)).toEqual(p0);
      expect(norm(sub(hermite(p0, v, p1, v, dt, 1), p1))).toBeLessThan(1e-9);
    }
  });
  it("demo window, relative time and clamp", () => {
    const w = demoWindow(cat.epoch);
    expect(w.now - w.start).toBe(2 * 3600e3);
    expect(relTime(w.now + 7 * 3600e3 + 21 * 60e3, w.now)).toBe("+7h 21m");
    expect(relTime(w.now - 5 * 60e3, w.now)).toBe("-0h 05m");
    expect(clamp(5, 0, 3)).toBe(3);
  });
});

describe("TLE format", () => {
  it("writes valid 69-column lines that parse back to the same elements", () => {
    const el = { norad: 70123, intl: "26001A", epoch, inclDeg: 53.0001, raanDeg: 359.99, ecc: 0.0001234, argpDeg: 90, meanAnomDeg: 12.3456, meanMotion: 15.0549197, bstar: 3.1e-5 };
    const [l1, l2] = toTle(el);
    expect(l1).toHaveLength(69); expect(l2).toHaveLength(69);
    expect(+l1[68]).toBe(checksum(l1)); expect(+l2[68]).toBe(checksum(l2));
    const s = parse(l1, l2);
    expect(s.inclo * 180 / Math.PI).toBeCloseTo(53.0001, 4);
    expect(s.ecco).toBeCloseTo(0.0001234, 7);
    expect(s.bstar).toBeCloseTo(3.1e-5, 9);
    expect(satEpoch(s).getTime()).toBeCloseTo(epoch.getTime(), -1);
    expect(expField(0)).toBe(" 00000-0");
    expect(expField(-0.00012345)).toBe("-12345-3");
    expect(() => toTle({ ...el, meanMotion: 123456 })).toThrow();
  });
  it("returns null where SGP4 fails", () => {
    const bad = parse(...toTle({ norad: 70999, intl: "26001A", epoch, inclDeg: 50, raanDeg: 0, ecc: 0.001, argpDeg: 0, meanAnomDeg: 0, meanMotion: 16.4, bstar: 0.5 }));
    expect(stateAt(bad, new Date(epoch.getTime() + 30 * 86400e3))).toBeNull();
  });
});

describe("synthetic catalog", () => {
  it("is deterministic and well formed", () => {
    expect(cat.objects.length).toBe(18050);
    const again = generateCatalog();
    expect(again.objects[1234].l2).toBe(cat.objects[1234].l2);
    expect(new Set(cat.objects.map((o) => o.norad)).size).toBe(cat.objects.length);
    expect(cat.objects.every((o) => o.norad >= 70001)).toBe(true);
    expect(cat.objects.filter((o) => o.operator === "aurora")).toHaveLength(60);
    expect(uuidFor(1, 70001)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(generateCatalog(1).objects[100].l2).not.toBe(cat.objects[100].l2);
  });
  it("plants three encounters at the aimed miss distance (within 25 m of TLE rounding)", () => {
    expect(cat.planted.map((p) => p.label)).toEqual(["high", "medium", "low"]);
    for (const p of cat.planted) {
      const a = sats[idx(p.primary)], b = sats[idx(p.secondary)];
      const t = new Date(p.tca);
      const d = norm(sub(stateAt(a, t)!.r, stateAt(b, t)!.r)) * 1000;
      expect(Math.abs(d - p.missM)).toBeLessThan(25);
    }
  });
});

describe("conjunction screening", () => {
  it("shell filter keeps overlapping orbits only", () => {
    expect(shellsOverlap({ perigeeKm: 540, apogeeKm: 560 }, { perigeeKm: 590, apogeeKm: 600 }, 25)).toBe(true);
    expect(shellsOverlap({ perigeeKm: 540, apogeeKm: 560 }, { perigeeKm: 700, apogeeKm: 720 }, 25)).toBe(false);
    const s = shellOf(sats[0]);
    expect(s.perigeeKm).toBeGreaterThan(520); expect(s.apogeeKm).toBeLessThan(580);
  });
  it("finds every encounter the slow reference finds (precision and recall on a 400-object subset)", async () => {
    const batch = await wasmBatch();
    const prim = [...new Set(cat.planted.map((p) => idx(p.primary)))].concat([0, 5, 22, 41, 59]);
    const r = rng(9);
    const subset = [...new Set([...cat.planted.map((p) => idx(p.secondary)), ...Array.from({ length: 400 }, () => r.int(60, cat.objects.length - 1))])];
    const keep = [...new Set([...prim, ...subset])].sort((a, b) => a - b);
    const local = keep.map((k) => sats[k]);
    const map = new Map(keep.map((k, i) => [k, i]));
    const fast = screen({ sats: local, primaries: prim.map((p) => map.get(p)!), start: epoch, hours: 24, batch });
    const truth = bruteForce({ sats: local, primaries: prim.map((p) => map.get(p)!), secondaries: subset.map((s) => map.get(s)!), start: epoch, hours: 24, stepSec: 5, batch });
    const m = matchEncounters(fast.encounters.filter((e) => !prim.includes(keep[e.secondary])), truth);
    expect(truth.length).toBeGreaterThan(5);
    expect(m.recall).toBe(1);
    expect(m.precision).toBe(1);
    batch.dispose();
  });
  it("JS and WASM propagation agree", async () => {
    const b = await wasmBatch();
    const ts = [epoch, new Date(epoch.getTime() + 5 * 3600e3)];
    const x = jsBatch(sats.slice(0, 300), ts), y = b(sats.slice(0, 300), ts);
    let worst = 0;
    for (let i = 0; i < x.pos.length; i++) worst = Math.max(worst, Math.abs(x.pos[i] - y.pos[i]));
    expect(worst).toBeLessThan(1e-9);
    b.dispose();
  });
});

describe("collision probability", () => {
  it("encounter-plane integral agrees with Monte Carlo", () => {
    const geoms: [number, [[number, number], [number, number]], number][] = [
      [0.04, [[0.3 ** 2, 0.01], [0.01, 0.09 ** 2]], 0.006],
      [0.26, [[0.45 ** 2, 0], [0, 3.7 ** 2]], 0.0026],
      [0, [[0.05 ** 2, 0], [0, 0.05 ** 2]], 0.01],
      [0.5, [[0.2 ** 2, -0.02], [-0.02, 0.4 ** 2]], 0.02],
    ];
    for (const [d, c, hbr] of geoms) {
      const p = pc2d(d, c, hbr), n = 4e6, mc = pcMonteCarlo(d, c, hbr, n);
      const se = Math.sqrt((p * (1 - p)) / n);
      expect(Math.abs(p - mc)).toBeLessThan(4 * se + 1e-9);
    }
    // closed form for a centred circular Gaussian: 1 - exp(-R^2 / 2 sigma^2)
    expect(pc2d(0, [[0.05 ** 2, 0], [0, 0.05 ** 2]], 0.01)).toBeCloseTo(1 - Math.exp(-(0.01 ** 2) / (2 * 0.05 ** 2)), 9);
    expect(pc2d(0.001, [[0, 0], [0, 0]], 0.01)).toBe(1);
    expect(pc2d(0.1, [[0, 0], [0, 0]], 0.01)).toBe(0);
  });
  it("builds covariance and risk levels", () => {
    const s = stateAt(sats[0], epoch)!;
    const C = covEci(s.r, s.v, [10, 100, 10]);
    const ip = encounterPlane(s.r, s.v, [s.r[0] + 0.1, s.r[1], s.r[2]], [s.v[1], -s.v[0], s.v[2]], C);
    expect(ip.missKm).toBeGreaterThan(0);
    expect(sigmaAt([10, 100, 10], 24, 1e-4)[1]).toBeGreaterThan(100);
    expect([riskLevel(2e-4), riskLevel(2e-6), riskLevel(1e-9)]).toEqual(["high", "medium", "low"]);
  });
});

describe("maneuvers", () => {
  const hi = cat.planted[0];
  const enc = screen({ sats: [sats[idx(hi.primary)], sats[idx(hi.secondary)]], primaries: [0], start: epoch, hours: 24 }).encounters
    .sort((a, b) => a.missKm - b.missKm)[0];
  const cj = toConjunction(enc, [cat.objects[idx(hi.primary)], cat.objects[idx(hi.secondary)]], [sats[idx(hi.primary)], sats[idx(hi.secondary)]], epoch, 0);
  const input = { primary: sats[idx(hi.primary)], secondary: sats[idx(hi.secondary)], tca: new Date(cj.tca), cov: cj.covKm2, hbrKm: cj.hbrM / 1000 };
  it("the planted high-risk encounter is high risk", () => {
    expect(cj.risk).toBe("high");
    expect(cj.missM).toBeLessThan(60);
  });
  it("RK4 two-body+J2 keeps energy close over a day; zero burn gives zero offset", () => {
    const s = stateAt(sats[0], epoch)!;
    let x = [...s.r, ...s.v] as [number, number, number, number, number, number];
    const e = (q: number[]) => (q[3] ** 2 + q[4] ** 2 + q[5] ** 2) / 2 - MU / Math.hypot(q[0], q[1], q[2]);
    const e0 = e(x);
    for (let i = 0; i < 8640; i++) x = rk4(x, 10);
    expect(Math.abs((e(x) - e0) / e0)).toBeLessThan(2e-3); // J2 makes energy oscillate a little; drift must stay small
    const off = burnOffsets(sats[0], epoch, [0, 0, 0], new Date(epoch.getTime() + 3600e3));
    expect(norm(off(new Date(epoch.getTime() + 1800e3)))).toBe(0);
    expect(norm(off(new Date(epoch.getTime() - 1000)))).toBe(0);
    const path = burnedPath(sats[0], epoch, [0, 0.1, 0], new Date(epoch.getTime() + 7200e3));
    expect(norm(sub(path(new Date(epoch.getTime() + 3600e3))!, stateAt(sats[0], new Date(epoch.getTime() + 3600e3))!.r))).toBeGreaterThan(0.1);
  });
  it("a bigger burn lowers Pc; each planned option meets the target with the smallest burn found", () => {
    const burn = new Date(input.tca.getTime() - 2 * 5700e3);
    const p = [0, 0.01, 0.03, 0.06].map((dv) => evaluateBurn(input, burn, [0, -dv, 0]).pc);
    expect(p[0]).toBeGreaterThan(1e-4);
    for (let i = 1; i < p.length; i++) expect(p[i]).toBeLessThan(p[i - 1]);
    const plan = planManeuvers(input, { notBefore: new Date(epoch.getTime() + 2 * 3600e3) });
    expect(plan.length).toBeGreaterThan(3);
    for (const o of plan) {
      expect(o.pc).toBeLessThanOrEqual(1e-6);
      expect(o.burn.getTime()).toBeGreaterThanOrEqual(epoch.getTime() + 2 * 3600e3);
      const smaller = evaluateBurn(input, o.burn, [0, o.dvRicMs[1] * 0.97, 0]);
      expect(smaller.pc).toBeGreaterThan(1e-6);
    }
    const two = twoOptions(plan)!;
    expect(two[0].dvMs).toBeLessThan(two[1].dvMs);
    expect(two[1].leadOrbits).toBeLessThan(two[0].leadOrbits);
    expect(twoOptions([])).toBeNull();
  });
  it("re-screens the burned path against nearby objects", () => {
    const end = new Date(input.tca.getTime() + 1800e3);
    const plan = twoOptions(planManeuvers(input, { notBefore: new Date(epoch.getTime() + 2 * 3600e3) }))!;
    const path = burnedPath(input.primary, plan[0].burn, plan[0].dvRicMs, end);
    const before = screenPath({ path: (t) => stateAt(input.primary, t)?.r ?? null, sats: [input.primary, input.secondary], candidates: [1], start: new Date(input.tca.getTime() - 600e3), end });
    const after = screenPath({ path, sats: [input.primary, input.secondary], candidates: [1], start: new Date(input.tca.getTime() - 600e3), end, thresholdKm: 0.5 });
    expect(before.length).toBe(1);
    expect(before[0].missKm).toBeLessThan(0.06);
    expect(after.every((e) => e.missKm > 0.3)).toBe(true);
  });
});

describe("ground stations and alerts", () => {
  it("passes start and end at the station's minimum elevation", () => {
    const ps = passes(sats[0], epoch, new Date(epoch.getTime() + 12 * 3600e3));
    expect(ps.length).toBeGreaterThan(5);
    for (const p of ps.slice(0, 6)) {
      const gs = GROUND_STATIONS.find((g) => g.id === p.station)!;
      expect(Math.abs(elevationDeg(sats[0], gs, new Date(p.aos)) - gs.minElevDeg)).toBeLessThan(0.3);
      expect(p.maxElevDeg).toBeGreaterThan(gs.minElevDeg);
    }
  });
  it("validates rules and matches conjunctions", () => {
    const rule: AlertRule = { name: "High Pc on my fleet", scope: "fleet", minPc: 1e-4, withinHours: 24, channel: "email", target: "ops@example.com" };
    expect(validateRule(rule)).toEqual([]);
    expect(validateRule({ ...rule, minPc: 2, channel: "sms", target: "x" }).length).toBe(3);
    expect(validateRule(null)).toEqual(["rule must be an object"]);
    expect(validateRule({ ...rule, scope: [], name: "", withinHours: 0, maxMissM: -1 }).length).toBe(4);
    expect(validateRule({ ...rule, channel: "webhook", target: "http://insecure" })).toEqual(["target: e-mail address or https URL"]);
    const c = { primaryNorad: 70015, secondaryNorad: 80000, tca: new Date(epoch.getTime() + 9 * 3600e3).toISOString(), missM: 41, pc: 3e-4 } as never;
    const now = new Date(epoch.getTime() + 2 * 3600e3);
    expect(matches(rule, [c], new Set([70015]), now)).toHaveLength(1);
    expect(matches({ ...rule, scope: [1] }, [c], new Set([70015]), now)).toHaveLength(0);
    expect(matches({ ...rule, maxMissM: 10 }, [c], new Set([70015]), now)).toHaveLength(0);
    expect(notificationText(rule, c, new Map([[70015, "AURORA-205"], [80000, "R/B 1"]]))).toContain("AURORA-205 vs R/B 1");
  });
});
