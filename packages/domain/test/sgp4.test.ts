// Golden-orbit tests: the 33 verification cases published with Vallado et al., "Revisiting Spacetrack Report #3" (AIAA 2006-6753).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sgp4 } from "satellite.js";
import { parse } from "../src/tle.ts";

const dir = new URL("../../../data/fixtures/sgp4-ver/", import.meta.url);
const tles = readFileSync(new URL("SGP4-VER.TLE", dir), "utf8").split(/\r?\n/).filter((l) => /^[12] /.test(l));
const out = readFileSync(new URL("java_sgp4_ver.out", dir), "utf8").split(/\r?\n/);
const cases: { satnum: string; rows: number[][] }[] = [];
for (const line of out) {
  if (/^\s*\d+\s+xx/.test(line)) cases.push({ satnum: line.trim().split(/\s+/)[0], rows: [] });
  else if (line.trim() && cases.length) cases.at(-1)!.rows.push(line.trim().split(/\s+/).slice(0, 7).map(Number));
}

describe("SGP4 against the AIAA 2006-6753 verification vectors", () => {
  it("has all 33 cases", () => {
    expect(cases.length).toBe(33);
    expect(tles.length).toBe(66);
  });
  cases.forEach((c, k) => {
    it(`case ${k + 1}: object ${c.satnum}, ${c.rows.length} epochs within 1 m and 1 mm/s`, () => {
      const sat = parse(tles[2 * k].slice(0, 69), tles[2 * k + 1].slice(0, 69));
      let worst = 0, compared = 0, errors = 0;
      for (const [t, x, y, z, vx, vy, vz] of c.rows) {
        const pv = sgp4(sat, t);
        if (!pv || typeof pv.position !== "object") { errors++; continue; } // SGP4 reports an error (decay, bad mean motion)
        const p = pv.position, v = pv.velocity!;
        worst = Math.max(worst, Math.abs(p.x - x), Math.abs(p.y - y), Math.abs(p.z - z));
        expect(Math.abs(v.x - vx) + Math.abs(v.y - vy) + Math.abs(v.z - vz)).toBeLessThan(3e-6);
        compared++;
      }
      // case 33334 is the book's deliberate error case (mean motion 0.00001 rev/day): SGP4 must refuse it
      if (c.satnum === "33334") expect(errors).toBe(c.rows.length);
      else expect(compared).toBeGreaterThan(0);
      expect(worst).toBeLessThan(1e-3);
    });
  });
});
