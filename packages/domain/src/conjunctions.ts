// Turns screened encounters into conjunction records (the shape stored in conjunction_events and shipped to the browser).
import type { SatRec } from "satellite.js";
import { mat, norm, sub, type M3, type V3 } from "./math.ts";
import type { SpaceObject } from "./catalog.ts";
import type { Encounter } from "./screen.ts";
import { covEci, encounterPlane, pc2d, riskLevel, sigmaAt, type RiskLevel } from "./pc.ts";
import { uuidFor } from "./catalog.ts";

export interface Conjunction {
  id: string;
  primaryNorad: number;
  secondaryNorad: number;
  tca: string;
  missM: number;
  relSpeedMs: number;
  hbrM: number;
  pc: number;
  risk: RiskLevel;
  sigmaPlaneM: [number, number];
  covKm2: M3; // combined, inertial, at TCA
  rPrimary: V3; vPrimary: V3; rSecondary: V3; vSecondary: V3;
}

export function toConjunction(e: Encounter, objs: SpaceObject[], sats: SatRec[], epoch: Date, seq: number): Conjunction {
  const a = objs[e.primary], b = objs[e.secondary];
  const h = (e.tca.getTime() - epoch.getTime()) / 3600e3;
  const C = mat.add(covEci(e.rPrimary, e.vPrimary, sigmaAt(a.sigmaM, h, sats[e.primary].bstar)), covEci(e.rSecondary, e.vSecondary, sigmaAt(b.sigmaM, h, sats[e.secondary].bstar)));
  const plane = encounterPlane(e.rPrimary, e.vPrimary, e.rSecondary, e.vSecondary, C);
  const hbrKm = (a.radiusM + b.radiusM) / 1000;
  const pc = pc2d(plane.missKm, plane.cov, hbrKm);
  return {
    id: uuidFor(3, seq), primaryNorad: a.norad, secondaryNorad: b.norad, tca: e.tca.toISOString(), missM: +(e.missKm * 1000).toFixed(1),
    relSpeedMs: +(norm(sub(e.vSecondary, e.vPrimary)) * 1000).toFixed(1), hbrM: +(hbrKm * 1000).toFixed(2), pc, risk: riskLevel(pc),
    sigmaPlaneM: [+plane.sigmaXm.toFixed(1), +plane.sigmaYm.toFixed(1)], covKm2: C,
    rPrimary: e.rPrimary, vPrimary: e.vPrimary, rSecondary: e.rSecondary, vSecondary: e.vSecondary,
  };
}
