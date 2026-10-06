// The planner on the demo's high-risk conjunction, and proof that the fast re-screen (near-pass list) gives the same answer as
// screening every candidate's new orbit against the whole shell.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { generateCatalog, parse, planWithRescreen, TARGET_PC, propellantKg, type Conjunction } from "../src/index.ts";
import { wasmBatch } from "../src/wasm.ts";

const cat = generateCatalog();
const sats = cat.objects.map((o) => parse(o.l1, o.l2));
const meta = cat.objects.map((o) => ({ radiusM: o.radiusM, sigma: o.sigmaM }));
const norads = cat.objects.map((o) => o.norad);
const conj: Conjunction[] = JSON.parse(readFileSync(new URL("../../../data/fixtures/conjunctions.json", import.meta.url), "utf8")).conjunctions;
const high = conj.find((c) => c.risk === "high")!;
const epoch = Date.parse(cat.epoch);

describe("planning with re-screening", () => {
  it("offers only options whose new orbit stays clean, and explains the rejected ones; fast and full re-screens agree", async () => {
    const batch = await wasmBatch();
    const args = { sats, meta, norads, epoch, conjunction: high, notBefore: new Date(epoch + 2 * 3600e3), massKg: 300, batch };
    const fast = planWithRescreen(args);
    expect(fast.options.length).toBe(2);
    for (const o of fast.options) { expect(o.safe).toBe(true); expect(o.pc).toBeLessThanOrEqual(TARGET_PC); expect(o.rescreen).toBe("near-list"); }
    expect(fast.options[0].dvMs).toBeLessThan(fast.options[1].dvMs);
    expect(fast.rejected.length).toBeGreaterThan(0);
    for (const r of fast.rejected) expect(r.worst!.pc).toBeGreaterThan(TARGET_PC);
    const full = planWithRescreen({ ...args, fullRescreen: true });
    const key = (x: { leadOrbits: number; dvMs: number }) => `${x.leadOrbits}:${x.dvMs.toFixed(6)}`;
    expect(full.options.map(key)).toEqual(fast.options.map(key));
    expect(full.rejected.map(key)).toEqual(fast.rejected.map(key));
    for (const [a, b] of fast.rejected.map((r, i) => [r, full.rejected[i]] as const)) {
      expect(b.rescreen).toBe("full");
      expect(Math.abs(a.worst!.missM - b.worst!.missM)).toBeLessThanOrEqual(1);
    }
    expect(propellantKg(0, 300)).toBe(0);
    expect(() => planWithRescreen({ ...args, conjunction: { ...high, primaryNorad: 1 } })).toThrow();
    batch.dispose();
  }, 300_000);
});
