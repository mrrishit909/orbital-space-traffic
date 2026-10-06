// Two-line element sets: build them from mean elements (fixed-column format with checksums) and parse them with satellite.js.
import { twoline2satrec, propagate as sgp4Propagate, type SatRec } from "satellite.js";
import type { V3 } from "./math.ts";

export interface Elements {
  norad: number;
  intl: string; // international designator, e.g. "26042A"
  epoch: Date;
  inclDeg: number;
  raanDeg: number;
  ecc: number;
  argpDeg: number;
  meanAnomDeg: number;
  meanMotion: number; // rev/day
  bstar: number;
  ndot?: number;
  revNumber?: number;
}

const wrap360 = (x: number) => ((x % 360) + 360) % 360;

export function checksum(line: string) {
  let s = 0;
  for (const ch of line.slice(0, 68)) {
    if (ch >= "0" && ch <= "9") s += +ch;
    else if (ch === "-") s += 1;
  }
  return s % 10;
}

/** TLE "assumed decimal point" exponent field, e.g. 0.00012345 -> " 12345-3". */
export function expField(x: number) {
  if (x === 0) return " 00000-0";
  const sign = x < 0 ? "-" : " ";
  let e = Math.floor(Math.log10(Math.abs(x))) + 1;
  let m = Math.round(Math.abs(x) / 10 ** e * 1e5);
  if (m >= 1e5) { m = Math.round(m / 10); e += 1; }
  const es = e < 0 ? `-${-e}` : `+${e}`;
  return `${sign}${String(m).padStart(5, "0")}${es}`.replace("+", "+");
}

export function epochField(d: Date) {
  const y = d.getUTCFullYear();
  const start = Date.UTC(y, 0, 1);
  const doy = (d.getTime() - start) / 86400000 + 1;
  return `${String(y % 100).padStart(2, "0")}${doy.toFixed(8).padStart(12, "0")}`;
}

export function toTle(el: Elements): [string, string] {
  const id = String(el.norad).padStart(5, "0");
  const ndot = (el.ndot ?? 0).toFixed(8).replace(/^(-?)0\./, "$1.");
  const l1 = `1 ${id}U ${el.intl.padEnd(8)} ${epochField(el.epoch)} ${ndot.padStart(10)}  00000-0 ${expField(el.bstar)} 0  999`;
  const ecc = Math.round(el.ecc * 1e7).toString().padStart(7, "0");
  const f = (x: number) => wrap360(x).toFixed(4).padStart(8);
  const l2 = `2 ${id} ${f(el.inclDeg)} ${f(el.raanDeg)} ${ecc} ${f(el.argpDeg)} ${f(el.meanAnomDeg)} ${el.meanMotion.toFixed(8).padStart(11)}${String(el.revNumber ?? 1000).padStart(5)}`;
  if (l1.length !== 68 || l2.length !== 68) throw new Error(`bad TLE width ${l1.length}/${l2.length} for ${id}`);
  return [l1 + checksum(l1), l2 + checksum(l2)];
}

export function parse(l1: string, l2: string): SatRec {
  return twoline2satrec(l1, l2);
}

export interface State { r: V3; v: V3 }

/** TEME position (km) and velocity (km/s), or null when SGP4 reports an error (decay, eccentricity out of range...). */
export function stateAt(sat: SatRec, t: Date): State | null {
  const pv = sgp4Propagate(sat, t);
  if (!pv || typeof pv.position !== "object" || !pv.position) return null;
  const p = pv.position, v = pv.velocity as { x: number; y: number; z: number };
  return { r: [p.x, p.y, p.z], v: [v.x, v.y, v.z] };
}

/** Epoch of a satrec as a Date. */
export function satEpoch(sat: SatRec) {
  return new Date((sat.jdsatepoch + ((sat as { jdsatepochF?: number }).jdsatepochF ?? 0) - 2440587.5) * 86400000);
}
