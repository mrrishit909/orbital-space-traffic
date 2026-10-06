// Scene stress: 50,000 objects propagated (WASM in a worker) and drawn; budgets are reported, not enforced, on software GL.
import { expect, test } from "@playwright/test";
import { writeFileSync, mkdirSync } from "node:fs";
import { ready, state } from "./helpers.ts";

test("50,000-object stress scene renders and reports its cost", async ({ page }) => {
  await ready(page, "/?enter=1");
  await page.getByRole("button", { name: /Failure lab/ }).click();
  await page.getByRole("menuitem", { name: /Stress test/ }).click();
  await expect.poll(async () => ((await state(page)).load as { status: string }).status, { timeout: 60_000 }).toBe("ready");
  await page.getByRole("button", { name: "Telemetry" }).click();
  await page.waitForTimeout(4000);
  const t = await page.evaluate(() => (window as unknown as { __orbital: { telemetry: () => Record<string, unknown> } }).__orbital.telemetry());
  expect(t.objects).toBe(50000);
  expect((t.render as { points: number }).points).toBeGreaterThanOrEqual(50000);
  expect(t.fps as number).toBeGreaterThan(0);
  const js = await page.evaluate(() => performance.getEntriesByType("resource").filter((r) => r.name.endsWith(".js")).reduce((s, r) => s + (r as PerformanceResourceTiming).encodedBodySize, 0));
  mkdirSync("docs", { recursive: true });
  writeFileSync("docs/performance-e2e.json", JSON.stringify({ note: "headless Chrome with SwiftShader (software GL): FPS here is a floor, not the desktop GPU figure", ...t, jsBytesTransferred: js }, null, 1));
});
