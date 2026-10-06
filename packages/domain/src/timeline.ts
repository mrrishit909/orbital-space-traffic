// Time handling shared by the scrubber, the renderer and the API: the demo clock and interpolation between propagated samples.
import type { V3 } from "./math.ts";

/** Cubic Hermite interpolation of position between two samples with velocities (exact for straight-line motion). */
export function hermite(p0: V3, v0: V3, p1: V3, v1: V3, dtSec: number, f: number): V3 {
  const f2 = f * f, f3 = f2 * f;
  const h00 = 2 * f3 - 3 * f2 + 1, h10 = f3 - 2 * f2 + f, h01 = -2 * f3 + 3 * f2, h11 = f3 - f2;
  return [0, 1, 2].map((i) => h00 * p0[i] + h10 * dtSec * v0[i] + h01 * p1[i] + h11 * dtSec * v1[i]) as V3;
}

export const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

/** The sandbox window: element-set epoch to 24 hours later. "Now" in the demo is epoch + 2 h. */
export interface Window { start: number; end: number; now: number }
export function demoWindow(epochIso: string): Window {
  const e = Date.parse(epochIso);
  return { start: e, end: e + 24 * 3600e3, now: e + 2 * 3600e3 };
}

/** Format a time as "+7h 21m" relative to now, the way the conjunction list shows it. */
export function relTime(t: number, now: number) {
  const m = Math.round((t - now) / 60000), s = m < 0 ? "-" : "+", a = Math.abs(m);
  return `${s}${Math.floor(a / 60)}h ${String(a % 60).padStart(2, "0")}m`;
}
