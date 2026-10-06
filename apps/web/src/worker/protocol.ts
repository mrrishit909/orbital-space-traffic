// Messages between the page and the propagation worker. Positions are in scene units (1 = 1,000 km), y up:
// scene (x, y, z) = TEME (x, z, -y) / 1000. Velocities in scene units per second.
import type { Conjunction, Pass, PlanOption } from "@orbital/domain";

export interface CompactCatalog {
  version: string; seed: number; epoch: string;
  operators: { slug: string; name: string }[];
  planted: { primary: number; secondary: number; tca: string; missM: number; label: string }[];
  fields: string[];
  objects: [number, string, string, number, string, number, number, number, number, number, string, string][];
}

export type { NewApproach, PlanOption } from "@orbital/domain";

export type ToWorker =
  | { type: "init"; catalog: CompactCatalog; extra: number }
  | { type: "positions"; id: number; t0: number; t1: number }
  | { type: "trail"; id: number; norad: number; t: number; samples: number }
  | { type: "plan"; id: number; conjunction: Conjunction; notBefore: number; massKg: number }
  | { type: "passes"; id: number; norad: number; start: number; end: number };

export type FromWorker =
  | { type: "ready"; n: number; wasm: boolean; ms: number }
  | { type: "positions"; id: number; t0: number; t1: number; p0: Float32Array; v0: Float32Array; p1: Float32Array; v1: Float32Array; ms: number }
  | { type: "trail"; id: number; norad: number; points: Float32Array; periodMin: number }
  | { type: "progress"; id: number; stage: string; fraction: number }
  | { type: "plan"; id: number; options: PlanOption[]; rejected: PlanOption[]; frontier: number; ms: number }
  | { type: "passes"; id: number; passes: Pass[] }
  | { type: "error"; id: number; message: string };
