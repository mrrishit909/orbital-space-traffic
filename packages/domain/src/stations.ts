// Ground stations and visibility windows. Station coordinates are real places (public geography); the network itself is invented.
import { degreesToRadians, ecfToLookAngles, eciToEcf, gstime, type SatRec } from "satellite.js";
import { stateAt } from "./tle.ts";

export interface GroundStation { id: string; name: string; latDeg: number; lonDeg: number; altKm: number; minElevDeg: number }

export const GROUND_STATIONS: GroundStation[] = [
  { id: "svalbard", name: "Svalbard", latDeg: 78.23, lonDeg: 15.39, altKm: 0.5, minElevDeg: 5 },
  { id: "fairbanks", name: "Fairbanks", latDeg: 64.86, lonDeg: -147.85, altKm: 0.2, minElevDeg: 10 },
  { id: "kiruna", name: "Kiruna", latDeg: 67.86, lonDeg: 20.96, altKm: 0.4, minElevDeg: 10 },
  { id: "hawaii", name: "South Point, Hawaii", latDeg: 19.01, lonDeg: -155.66, altKm: 0.4, minElevDeg: 10 },
  { id: "santiago", name: "Santiago", latDeg: -33.15, lonDeg: -70.67, altKm: 0.7, minElevDeg: 10 },
  { id: "hartebeesthoek", name: "Hartebeesthoek", latDeg: -25.89, lonDeg: 27.69, altKm: 1.5, minElevDeg: 10 },
  { id: "perth", name: "Perth", latDeg: -31.8, lonDeg: 115.89, altKm: 0.02, minElevDeg: 10 },
  { id: "troll", name: "Troll, Antarctica", latDeg: -72.01, lonDeg: 2.53, altKm: 1.3, minElevDeg: 5 },
];

export function elevationDeg(sat: SatRec, gs: GroundStation, t: Date): number {
  const s = stateAt(sat, t);
  if (!s) return -90;
  const ecf = eciToEcf({ x: s.r[0], y: s.r[1], z: s.r[2] }, gstime(t));
  const look = ecfToLookAngles({ latitude: degreesToRadians(gs.latDeg), longitude: degreesToRadians(gs.lonDeg), height: gs.altKm }, ecf);
  return (look.elevation * 180) / Math.PI;
}

export interface Pass { station: string; aos: string; los: string; maxElevDeg: number }

/** Passes above each station's minimum elevation in [start, end): 30 s scan, then bisection to 0.5 s on rise and set. */
export function passes(sat: SatRec, start: Date, end: Date, stations = GROUND_STATIONS): Pass[] {
  const out: Pass[] = [];
  for (const gs of stations) {
    const above = (t: number) => elevationDeg(sat, gs, new Date(t)) >= gs.minElevDeg;
    const edge = (a: number, b: number) => { const va = above(a); while (b - a > 500) { const m = (a + b) / 2; if (above(m) === va) a = m; else b = m; } return b; };
    let prev = above(start.getTime()), aos = prev ? start.getTime() : 0, maxE = -90;
    for (let t = start.getTime() + 30e3; t <= end.getTime(); t += 30e3) {
      const now = above(t);
      if (now) maxE = Math.max(maxE, elevationDeg(sat, gs, new Date(t)));
      if (now && !prev) { aos = edge(t - 30e3, t); maxE = elevationDeg(sat, gs, new Date(t)); }
      if (!now && prev) out.push({ station: gs.id, aos: new Date(aos).toISOString(), los: new Date(edge(t - 30e3, t)).toISOString(), maxElevDeg: +maxE.toFixed(1) });
      prev = now;
    }
  }
  return out.sort((a, b) => a.aos.localeCompare(b.aos));
}
