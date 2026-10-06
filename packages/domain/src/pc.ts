// Collision probability in the encounter plane (the short-encounter, "2D Pc" formulation): combine the two position covariances,
// project onto the plane perpendicular to the relative velocity at TCA, and integrate the Gaussian over the hard-body circle.
import { cross, dot, mat, norm, ricBasis, scale, sub, unit, type M3, type V3 } from "./math.ts";
import { mulberry32 } from "./rng.ts";

/** Synthetic covariance growth: in-track uncertainty grows with time since epoch, faster for objects with more drag. */
export function sigmaAt(sigmaM: [number, number, number], hoursSinceEpoch: number, bstar: number): [number, number, number] {
  const g = 1 + (0.25 + 4000 * Math.abs(bstar)) * (hoursSinceEpoch / 24);
  return [sigmaM[0] * Math.sqrt(g), sigmaM[1] * g, sigmaM[2] * Math.sqrt(g)];
}

/** Position covariance (km^2) in the inertial frame from radial / in-track / cross-track sigmas in metres. */
export function covEci(r: V3, v: V3, sigmaM: [number, number, number]): M3 {
  const B = ricBasis(r, v); // rows: R, I, C
  const D = mat.diag((sigmaM[0] / 1000) ** 2, (sigmaM[1] / 1000) ** 2, (sigmaM[2] / 1000) ** 2);
  return mat.mul(mat.t(B), mat.mul(D, B));
}

export interface EncounterPlane {
  missKm: number;
  /** 2x2 combined covariance in the plane (km^2): x along the miss vector, y completes the right-handed set with the relative velocity */
  cov: [[number, number], [number, number]];
  sigmaXm: number;
  sigmaYm: number;
  /** basis vectors (inertial) for drawing: x = miss direction, y, z = relative velocity direction */
  basis: [V3, V3, V3];
}

export function encounterPlane(r1: V3, v1: V3, r2: V3, v2: V3, C: M3): EncounterPlane {
  const dr = sub(r2, r1), dv = sub(v2, v1);
  const z = unit(dv);
  // miss vector component perpendicular to the relative velocity (at true TCA it is already perpendicular)
  const x0 = sub(dr, scale(z, dot(dr, z)));
  const x = norm(x0) > 1e-12 ? unit(x0) : unit(cross(z, [0, 0, 1]));
  const y = cross(z, x);
  const Cx = mat.vec(C, x), Cy = mat.vec(C, y);
  const cov: [[number, number], [number, number]] = [[dot(x, Cx), dot(x, Cy)], [dot(y, Cx), dot(y, Cy)]];
  return { missKm: norm(x0), cov, sigmaXm: Math.sqrt(cov[0][0]) * 1000, sigmaYm: Math.sqrt(cov[1][1]) * 1000, basis: [x, y, z] };
}

// Gauss-Legendre nodes/weights on [-1, 1], 20 points
const GL = (() => {
  const n = 20, xs: number[] = [], ws: number[] = [];
  for (let i = 1; i <= n; i++) {
    let x = Math.cos((Math.PI * (i - 0.25)) / (n + 0.5));
    for (let it = 0; it < 100; it++) {
      let p0 = 1, p1 = x;
      for (let k = 2; k <= n; k++) { const p2 = ((2 * k - 1) * x * p1 - (k - 1) * p0) / k; p0 = p1; p1 = p2; }
      const dp = (n * (x * p1 - p0)) / (x * x - 1);
      const dx = p1 / dp; x -= dx;
      if (Math.abs(dx) < 1e-15) { ws.push(2 / ((1 - x * x) * dp * dp)); break; }
    }
    xs.push(x);
  }
  return { xs, ws };
})();

/** Probability that the miss falls inside the hard-body circle: integral of N((miss, 0), cov) over the disc radius hbrKm. */
export function pc2d(missKm: number, cov: [[number, number], [number, number]], hbrKm: number): number {
  const [[a, b], [, d]] = cov;
  const det = a * d - b * b;
  if (!(det > 0)) return missKm <= hbrKm ? 1 : 0;
  const ia = d / det, ib = -b / det, id = a / det;
  const k = 1 / (2 * Math.PI * Math.sqrt(det));
  // polar grid centred on the disc: x = rho cos(th), y = rho sin(th); 20-point Gauss-Legendre in rho and 4x20 in theta
  let s = 0;
  for (let i = 0; i < GL.xs.length; i++) {
    const rho = (hbrKm / 2) * (GL.xs[i] + 1), wr = (hbrKm / 2) * GL.ws[i];
    for (let q = 0; q < 4; q++) for (let j = 0; j < GL.xs.length; j++) {
      const th = (Math.PI / 4) * (GL.xs[j] + 1) + (q * Math.PI) / 2, wt = (Math.PI / 4) * GL.ws[j];
      const ex = rho * Math.cos(th) - missKm, ey = rho * Math.sin(th);
      s += wr * wt * rho * Math.exp(-0.5 * (ia * ex * ex + 2 * ib * ex * ey + id * ey * ey));
    }
  }
  return Math.min(1, k * s);
}

/** Monte Carlo check of pc2d (used in tests and the evaluation write-up). */
export function pcMonteCarlo(missKm: number, cov: [[number, number], [number, number]], hbrKm: number, n: number, seed = 7) {
  const u = mulberry32(seed);
  const [[a, b], [, d]] = cov;
  const l11 = Math.sqrt(a), l21 = b / l11, l22 = Math.sqrt(d - l21 * l21);
  let hits = 0;
  for (let i = 0; i < n; i++) {
    const r = Math.sqrt(-2 * Math.log(1 - u())), t = 2 * Math.PI * u();
    const z1 = r * Math.cos(t), z2 = r * Math.sin(t);
    const x = missKm + l11 * z1, y = l21 * z1 + l22 * z2;
    if (x * x + y * y <= hbrKm * hbrKm) hits++;
  }
  return hits / n;
}

export type RiskLevel = "high" | "medium" | "low";
/** Thresholds commonly used in operations: 1e-4 for action, 1e-6 for watch. */
export const riskLevel = (pc: number): RiskLevel => (pc >= 1e-4 ? "high" : pc >= 1e-6 ? "medium" : "low");
