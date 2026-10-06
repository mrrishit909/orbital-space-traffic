// Synthetic space-object catalog. Nothing here is a real object: shells, constellations and debris clouds are shaped like the
// real near-Earth population, but every element set is drawn from a seeded generator. NORAD-style ids start at 70001 so they
// can't be mistaken for real catalog numbers (real ones were below ~68,000 in 2026).
import { DEG, RE, meanMotionFromSma, norm, solve, sub, add, scale, unit, cross, dot, type V3 } from "./math.ts";
import { rng, type Rng } from "./rng.ts";
import { toTle, parse, stateAt, type Elements } from "./tle.ts";

export type ObjectType = "payload" | "rocket_body" | "debris" | "unknown";

export interface SpaceObject {
  id: string; // uuid
  norad: number;
  cospar: string;
  name: string;
  type: ObjectType;
  operator: string | null; // operator org slug
  family: string;
  radiusM: number;
  massKg: number;
  sigmaM: [number, number, number]; // 1-sigma position uncertainty at epoch, radial / in-track / cross-track, metres
  l1: string;
  l2: string;
}

export interface PlantedEvent {
  primary: number; // norad
  secondary: number;
  tca: string; // ISO time the generator aimed at
  missM: number; // miss distance the generator aimed at
  label: "high" | "medium" | "low";
}

export interface Catalog {
  version: string;
  seed: number;
  epoch: string; // all element sets share this epoch; demo "now" is epoch + 2h
  generatedBy: string;
  operators: { slug: string; name: string; demo: true }[];
  objects: SpaceObject[];
  planted: PlantedEvent[];
}

export const OPERATORS = [
  { slug: "aurora", name: "Aurora Constellation", demo: true as const },
  { slug: "lattice", name: "Lattice Broadband", demo: true as const },
  { slug: "polar-relay", name: "Polar Relay", demo: true as const },
  { slug: "terra-imaging", name: "Terra Imaging", demo: true as const },
  { slug: "navstar-like", name: "Meridian Navigation", demo: true as const },
  { slug: "geo-comms", name: "Equator Comms", demo: true as const },
];

/** Deterministic uuid-shaped id from a number (so ids are stable across runs and databases). */
export function uuidFor(kind: number, n: number) {
  const h = (x: number) => (x >>> 0).toString(16).padStart(8, "0");
  let a = (n * 2654435761) ^ (kind * 40503);
  a = Math.imul(a ^ (a >>> 16), 0x45d9f3b);
  const b = Math.imul(n + 0x9e3779b9, 0x85ebca6b) ^ kind;
  return `${h(a)}-${h(n).slice(4)}-4${h(kind).slice(5)}-8${h(b).slice(5)}-${h(b ^ a)}${h(n).slice(4)}`;
}

interface Draft {
  type: ObjectType;
  operator: string | null;
  family: string;
  name: string;
  altKm: number;
  ecc: number;
  incl: number;
  raan: number;
  argp: number;
  ma: number;
  radiusM: number;
  massKg: number;
  sigmaM: [number, number, number];
  bstar: number;
}

const SIGMA = {
  owner: [15, 60, 15] as [number, number, number], // operator-supplied ephemeris
  payload: [60, 400, 60] as [number, number, number],
  rocket_body: [80, 500, 80] as [number, number, number],
  debris: [150, 1200, 150] as [number, number, number],
};

function drafts(r: Rng): Draft[] {
  const out: Draft[] = [];
  const push = (d: Partial<Draft> & Pick<Draft, "type" | "family" | "name" | "altKm" | "incl">) =>
    out.push({ operator: null, ecc: 0.0001 + r.u() * 0.0008, raan: r.range(0, 360), argp: r.range(0, 360), ma: r.range(0, 360),
      radiusM: 1, massKg: 100, sigmaM: SIGMA.payload, bstar: 2e-5 + r.u() * 6e-5, ...d });

  // The demo operator's own fleet: 6 planes x 10 satellites at 550 km, 53 deg, operator ephemeris (small covariance).
  for (let p = 0; p < 6; p++) for (let s = 0; s < 10; s++)
    push({ type: "payload", operator: "aurora", family: "aurora", name: `AURORA-${p + 1}${String(s + 1).padStart(2, "0")}`, altKm: 550,
      incl: 53, raan: p * 60 + 7, ma: s * 36 + p * 6, ecc: 0.00012, argp: 90, radiusM: 2, massKg: 300, sigmaM: SIGMA.owner, bstar: 3e-5 });
  // A large broadband constellation sharing the 540-570 km band.
  const latticeShells = [[540, 53.2, 1100], [560, 97.6, 260], [570, 70, 240]] as const;
  let n = 0;
  for (const [alt, inc, count] of latticeShells) {
    const planes = Math.round(Math.sqrt(count) * 1.2);
    for (let k = 0; k < count; k++)
      push({ type: "payload", operator: "lattice", family: "lattice", name: `LATTICE-${++n}`, altKm: alt + r.normal(0, 0.6), incl: inc,
        raan: (k % planes) * (360 / planes), ma: Math.floor(k / planes) * (360 / Math.ceil(count / planes)) + r.range(0, 2), radiusM: 2.5, massKg: 800 });
  }
  for (let k = 0; k < 360; k++)
    push({ type: "payload", operator: "polar-relay", family: "polar-relay", name: `POLAR-RELAY-${k + 1}`, altKm: 1100, incl: 86.4,
      raan: (k % 12) * 15, ma: Math.floor(k / 12) * 12, radiusM: 2, massKg: 700 });
  for (let k = 0; k < 900; k++) {
    const alt = r.range(480, 820);
    push({ type: "payload", operator: k < 120 ? "terra-imaging" : null, family: "sso", name: k < 120 ? `TERRA-IMG-${k + 1}` : `SSO-SAT-${k + 1}`,
      altKm: alt, incl: 96.9 + (alt - 480) * 0.0045 + r.normal(0, 0.05), radiusM: r.range(0.5, 3), massKg: r.range(20, 2500) });
  }
  // Two old fragmentation clouds and a field of scattered debris.
  const clouds = [[850, 98.8, 3200, "CLOUD-A DEB"], [790, 74, 1400, "CLOUD-B DEB"], [790, 86.4, 700, "CLOUD-C DEB"]] as const;
  for (const [alt, inc, count, nm] of clouds)
    for (let k = 0; k < count; k++)
      push({ type: "debris", family: nm.split(" ")[0].toLowerCase(), name: `${nm} ${k + 1}`, altKm: alt + r.normal(0, 45), ecc: Math.abs(r.normal(0, 0.006)) + 0.0002,
        incl: inc + r.normal(0, 0.25), radiusM: Math.min(1.2, 0.03 + Math.abs(r.normal(0, 0.18))), massKg: r.range(0.01, 5), sigmaM: SIGMA.debris, bstar: 1e-4 + r.u() * 6e-4 });
  for (let k = 0; k < 5200; k++) {
    const alt = 300 + Math.abs(r.normal(0, 1)) * 520;
    push({ type: "debris", family: "leo-debris", name: `DEBRIS ${k + 1}`, altKm: Math.min(alt, 2000), ecc: Math.abs(r.normal(0, 0.01)) + 0.0002,
      incl: r.pick([28.5, 51.6, 65, 74, 82, 98.2, 99, 71]) + r.normal(0, 1.5), radiusM: Math.min(1, 0.03 + Math.abs(r.normal(0, 0.2))), massKg: r.range(0.01, 20), sigmaM: SIGMA.debris, bstar: 1e-4 + r.u() * 8e-4 });
  }
  for (let k = 0; k < 800; k++)
    push({ type: "rocket_body", family: "rocket-body", name: `R/B ${k + 1}`, altKm: r.range(350, 1500), ecc: Math.abs(r.normal(0, 0.02)) + 0.0005,
      incl: r.pick([28.5, 51.6, 63.4, 71, 82.9, 97.6, 98.5]) + r.normal(0, 0.4), radiusM: r.range(1.5, 4), massKg: r.range(800, 9000), sigmaM: SIGMA.rocket_body });
  for (let k = 0; k < 2600; k++) {
    const sso = r.u() < 0.5;
    push({ type: "payload", family: "leo-other", name: `LEO-SAT-${k + 1}`, altKm: r.range(350, 1400), incl: sso ? 97.5 + r.normal(0, 0.6) : r.pick([0, 28.5, 45, 51.6, 63, 66, 82]) + r.normal(0, 2),
      radiusM: r.range(0.3, 4), massKg: r.range(5, 4000) });
  }
  for (let k = 0; k < 120; k++)
    push({ type: "payload", operator: "navstar-like", family: "meo-nav", name: `MERIDIAN-${k + 1}`, altKm: 20200 + r.normal(0, 30), incl: 55 + r.normal(0, 0.5),
      raan: (k % 6) * 60, ma: Math.floor(k / 6) * 18, radiusM: 3, massKg: 1600, bstar: 0 });
  for (let k = 0; k < 640; k++)
    push({ type: k % 4 === 0 ? "rocket_body" : "payload", operator: k % 4 === 0 ? null : k < 160 ? "geo-comms" : null, family: "geo",
      name: k % 4 === 0 ? `GEO R/B ${k + 1}` : k < 160 ? `EQUATOR-${k + 1}` : `GEO-SAT-${k + 1}`, altKm: 35786 + r.normal(0, 60), incl: Math.abs(r.normal(0, 4)),
      radiusM: 4, massKg: 3500, bstar: 0, ecc: 0.0002 + r.u() * 0.001 });
  for (let k = 0; k < 70; k++)
    push({ type: "payload", family: "heo", name: `HEO-SAT-${k + 1}`, altKm: 26560 - RE, ecc: 0.72 + r.normal(0, 0.01), incl: 63.4 + r.normal(0, 0.3), argp: 270, radiusM: 3, massKg: 1800, bstar: 0 });
  for (let k = 0; k < 400; k++)
    push({ type: "debris", family: "gto-debris", name: `GTO DEB ${k + 1}`, altKm: 24400 - RE, ecc: 0.71 + r.normal(0, 0.01), incl: r.pick([7, 28.5, 18]) + r.normal(0, 1),
      radiusM: 0.3, massKg: 2, sigmaM: SIGMA.debris, bstar: 1e-4 });
  return out;
}

function elementsOf(d: Draft, norad: number, epoch: Date): Elements {
  const a = RE + d.altKm;
  // for eccentric orbits altKm is (semi-major axis - RE): keep perigee above 200 km
  const ecc = Math.min(d.ecc, Math.max(0, 1 - (RE + 200) / a));
  return { norad, intl: `${18 + (norad % 9)}${String(1 + (norad % 98)).padStart(3, "0")}${"ABCDEFGHJK"[norad % 10]}`, epoch,
    inclDeg: d.incl, raanDeg: d.raan, ecc, argpDeg: d.argp, meanAnomDeg: d.ma, meanMotion: meanMotionFromSma(a), bstar: d.bstar };
}

/**
 * Re-aim a secondary object so that SGP4 puts it at `target` at time `t`, by Newton iteration on its TLE (mean anomaly, RAAN, mean
 * motion: two directions on the sphere plus the radius). The TLE text itself is the function being solved, so its 4-decimal
 * rounding is part of the result; the final miss is re-measured by the screener rather than trusted from here.
 */
export function aimElements(el: Elements, t: Date, target: V3, iters = 12): Elements {
  let x = [el.meanAnomDeg, el.raanDeg, el.meanMotion];
  const pos = (v: number[]) => {
    const s = stateAt(parse(...toTle({ ...el, meanAnomDeg: v[0], raanDeg: v[1], meanMotion: v[2] })), t);
    if (!s) throw new Error("aim: propagation failed");
    return s.r;
  };
  const steps = [0.002, 0.002, 2e-6];
  for (let it = 0; it < iters; it++) {
    const r0 = pos(x);
    const res = sub(target, r0);
    if (norm(res) < 0.003) break;
    const J: number[][] = [[], [], []];
    for (let k = 0; k < 3; k++) {
      const xp = [...x]; xp[k] += steps[k];
      const d = sub(pos(xp), r0);
      for (let i = 0; i < 3; i++) J[i][k] = d[i] / steps[k];
    }
    const dx = solve(J, res);
    x = x.map((v, k) => v + dx[k]);
  }
  return { ...el, meanAnomDeg: ((x[0] % 360) + 360) % 360, raanDeg: ((x[1] % 360) + 360) % 360, meanMotion: x[2] };
}

/** Initial guess: a near-circular orbit of inclination `incl` passing through position `r` at time `t`. */
function throughPoint(base: Elements, r: V3, t: Date, incl: number, descending: boolean): Elements {
  const rr = norm(r), dec = Math.asin(r[2] / rr), ra = Math.atan2(r[1], r[0]);
  const i = incl * DEG;
  let u = Math.asin(Math.max(-1, Math.min(1, Math.sin(dec) / Math.sin(i))));
  if (descending) u = Math.PI - u;
  const raan = ra - Math.atan2(Math.cos(i) * Math.sin(u), Math.cos(u));
  const n = meanMotionFromSma(rr);
  const dtMin = (t.getTime() - base.epoch.getTime()) / 60000;
  const ma = (u / DEG - base.argpDeg) - n * 360 / 1440 * dtMin;
  return { ...base, inclDeg: incl, raanDeg: raan / DEG, meanMotion: n, meanAnomDeg: ((ma % 360) + 360) % 360, ecc: 0.0004 };
}

export function generateCatalog(seed = 20261006, epoch = new Date("2026-10-06T00:00:00Z")): Catalog {
  const r = rng(seed);
  const ds = drafts(r);
  const objects: SpaceObject[] = [];
  const els: Elements[] = [];
  ds.forEach((d, k) => {
    const norad = 70001 + k;
    const el = elementsOf(d, norad, epoch);
    els.push(el);
    const [l1, l2] = toTle(el);
    objects.push({ id: uuidFor(1, norad), norad, cospar: el.intl, name: d.name, type: d.type, operator: d.operator, family: d.family,
      radiusM: +d.radiusM.toFixed(2), massKg: +d.massKg.toFixed(2), sigmaM: d.sigmaM, l1, l2 });
  });

  // Planted encounters for the demo: three Aurora satellites each get a crossing object aimed at a chosen miss distance.
  const plan: { primary: number; secondaryType: ObjectType; hours: number; missM: number; crossDeg: number; label: PlantedEvent["label"] }[] = [
    { primary: 70001 + 14, secondaryType: "rocket_body", hours: 9.35, missM: 45, crossDeg: 97.6, label: "high" },
    { primary: 70001 + 33, secondaryType: "debris", hours: 15.8, missM: 260, crossDeg: 74, label: "medium" },
    { primary: 70001 + 47, secondaryType: "debris", hours: 5.1, missM: 1900, crossDeg: 86.4, label: "low" },
  ];
  const planted: PlantedEvent[] = [];
  for (const p of plan) {
    const prim = objects.find((o) => o.norad === p.primary)!;
    const t = new Date(epoch.getTime() + p.hours * 3600e3);
    const sp = stateAt(parse(prim.l1, prim.l2), t)!;
    // reuse an existing object of the right type as the secondary (it keeps its id and name, gets new elements)
    const cand = objects.filter((o) => o.type === p.secondaryType && o.operator === null && ["leo-debris", "rocket-body"].includes(o.family) && !planted.some((q) => q.secondary === o.norad));
    const sec = cand[r.int(0, cand.length - 1)];
    const k = sec.norad - 70001;
    let el = throughPoint(els[k], sp.r, t, p.crossDeg, r.u() < 0.5);
    el = aimElements(el, t, sp.r);
    // aim again at an offset perpendicular to the relative velocity, so TCA stays at t and the miss is the offset
    const ss = stateAt(parse(...toTle(el)), t)!;
    const vrel = sub(ss.v, sp.v);
    const any = cross(unit(vrel), r.u() < 0.5 ? [0, 0, 1] : unit(sp.r));
    const ax = unit(sub(any, scale(unit(vrel), dot(any, unit(vrel)))));
    el = aimElements(el, t, add(sp.r, scale(ax, p.missM / 1000)));
    els[k] = el;
    const [l1, l2] = toTle(el);
    Object.assign(sec, { l1, l2, radiusM: p.secondaryType === "rocket_body" ? 3.4 : 0.6 });
    planted.push({ primary: p.primary, secondary: sec.norad, tca: t.toISOString(), missM: p.missM, label: p.label });
  }
  return { version: "catalog-v1", seed, epoch: epoch.toISOString(), generatedBy: "data/simulators/generate.ts", operators: OPERATORS, objects, planted };
}
