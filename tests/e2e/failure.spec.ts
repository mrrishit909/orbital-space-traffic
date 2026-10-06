// The realistic failure cases are demonstrable and recover: the element-set feed goes down, the GPU context is lost.
import { expect, test } from "@playwright/test";
import { ready, state } from "./helpers.ts";

test("feed outage: backoff retries, last good catalog stays usable, recovery", async ({ page }) => {
  await ready(page, "/?enter=1");
  await page.getByRole("button", { name: /Failure lab/ }).click();
  await page.getByRole("menuitem", { name: "Cut the element-set feed" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Element-set feed unavailable" })).toBeVisible({ timeout: 10_000 });
  await expect.poll(async () => ((await state(page)).feed as { status: string }).status).toBe("retrying");
  // still usable while down
  await page.keyboard.press("]");
  await expect.poll(async () => (await state(page)).view).toBe("encounter");
  await page.getByRole("button", { name: /Failure lab/ }).click();
  await page.getByRole("menuitem", { name: "Restore the feed" }).click();
  await expect(page.getByText(/Feed recovered/).first()).toBeVisible({ timeout: 30_000 });
  expect(((await state(page)).load as { status: string }).status).toBe("ready");
});

test("GPU context loss falls back to the list view and comes back", async ({ page }) => {
  await ready(page, "/?enter=1");
  const ok = await page.evaluate(() => !!document.querySelector<HTMLCanvasElement>(".globe canvas")?.getContext("webgl2")?.getExtension("WEBGL_lose_context"));
  test.skip(!ok, "no WEBGL_lose_context in this browser");
  await page.evaluate(() => { (window as unknown as { __lose: unknown }).__lose = document.querySelector<HTMLCanvasElement>(".globe canvas")!.getContext("webgl2")!.getExtension("WEBGL_lose_context"); (window as unknown as { __lose: { loseContext(): void } }).__lose.loseContext(); });
  await expect.poll(async () => (await state(page)).webgl).toBe("lost");
  await expect(page.getByRole("main", { name: "List view" })).toContainText("GPU context was lost");
  await page.evaluate(() => (window as unknown as { __lose: { restoreContext(): void } }).__lose.restoreContext());
  await expect.poll(async () => (await state(page)).webgl).toBe("ok");
});
