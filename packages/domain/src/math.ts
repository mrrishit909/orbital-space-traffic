// Small vector / matrix helpers and unit conversions. Units: km, km/s, seconds, radians unless a name says otherwise.

export type V3 = [number, number, number];
export type M3 = [V3, V3, V3];

export const DEG = Math.PI / 180;
export const MU = 398600.8; // km^3/s^2, WGS-72 (the constant SGP4 uses)
export const RE = 6378.135; // km, WGS-72 equatorial radius
export const J2 = 0.001082616;
export const MIN_PER_DAY = 1440;

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a: V3) => Math.hypot(a[0], a[1], a[2]);
export const unit = (a: V3): V3 => scale(a, 1 / norm(a));

export const kmToM = (km: number) => km * 1000;
export const mToKm = (m: number) => m / 1000;
export const revPerDayToRadPerSec = (n: number) => (n * 2 * Math.PI) / 86400;
export const radPerSecToRevPerDay = (w: number) => (w * 86400) / (2 * Math.PI);
/** Semi-major axis (km) for a mean motion in rev/day. */
export const smaFromMeanMotion = (n: number) => Math.cbrt(MU / revPerDayToRadPerSec(n) ** 2);
export const meanMotionFromSma = (a: number) => radPerSecToRevPerDay(Math.sqrt(MU / a ** 3));

/** Rows are the radial, in-track and cross-track unit vectors of an orbit at (r, v). */
export function ricBasis(r: V3, v: V3): M3 {
  const R = unit(r);
  const C = unit(cross(r, v));
  const I = cross(C, R);
  return [R, I, C];
}

export const mat = {
  mul(a: M3, b: M3): M3 {
    const o = [[0, 0, 0], [0, 0, 0], [0, 0, 0]] as M3;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i][j] += a[i][k] * b[k][j];
    return o;
  },
  t(a: M3): M3 {
    return [[a[0][0], a[1][0], a[2][0]], [a[0][1], a[1][1], a[2][1]], [a[0][2], a[1][2], a[2][2]]];
  },
  add(a: M3, b: M3): M3 {
    return a.map((row, i) => row.map((x, j) => x + b[i][j])) as M3;
  },
  diag(a: number, b: number, c: number): M3 {
    return [[a, 0, 0], [0, b, 0], [0, 0, c]];
  },
  vec(a: M3, v: V3): V3 {
    return [dot(a[0], v), dot(a[1], v), dot(a[2], v)];
  },
};

/** Solve a small dense linear system (Gaussian elimination with partial pivoting). */
export function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-300) throw new Error("singular system");
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

/** Brent's method for the minimum of f on [a, b]. */
export function brentMin(f: (x: number) => number, a: number, b: number, tol = 1e-4, maxIter = 100): { x: number; fx: number } {
  const g = 0.3819660112501051;
  let x = a + g * (b - a), w = x, v = x;
  let fx = f(x), fw = fx, fv = fx;
  let d = 0, e = 0;
  for (let i = 0; i < maxIter; i++) {
    const m = 0.5 * (a + b);
    const tol1 = tol * Math.abs(x) + 1e-10, tol2 = 2 * tol1;
    if (Math.abs(x - m) <= tol2 - 0.5 * (b - a)) break;
    let useGolden = true;
    if (Math.abs(e) > tol1) {
      const r = (x - w) * (fx - fv);
      let q = (x - v) * (fx - fw);
      let p = (x - v) * q - (x - w) * r;
      q = 2 * (q - r);
      if (q > 0) p = -p; else q = -q;
      if (Math.abs(p) < Math.abs(0.5 * q * e) && p > q * (a - x) && p < q * (b - x)) {
        e = d; d = p / q; useGolden = false;
        const u = x + d;
        if (u - a < tol2 || b - u < tol2) d = x < m ? tol1 : -tol1;
      }
    }
    if (useGolden) { e = (x < m ? b : a) - x; d = g * e; }
    const u = Math.abs(d) >= tol1 ? x + d : x + (d > 0 ? tol1 : -tol1);
    const fu = f(u);
    if (fu <= fx) {
      if (u < x) b = x; else a = x;
      v = w; fv = fw; w = x; fw = fx; x = u; fx = fu;
    } else {
      if (u < x) a = u; else b = u;
      if (fu <= fw || w === x) { v = w; fv = fw; w = u; fw = fu; }
      else if (fu <= fv || v === x || v === w) { v = u; fv = fu; }
    }
  }
  return { x, fx };
}
