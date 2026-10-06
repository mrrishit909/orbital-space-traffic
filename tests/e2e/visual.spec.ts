// Visual regression on key motion states (not just the first frame): shell reveal, the encounter at closest approach, the plan view.
import { expect, test } from "@playwright/test";
import { ready, state } from "./helpers.ts";

test.use({ reducedMotion: "reduce" }); // states land instantly, so each screenshot is of a settled state

test("intro shells, encounter at TCA, plan view", async ({ page }) => {
  await ready(page);
  await page.getByLabel("Introduction").evaluate((el) => el.querySelectorAll("[data-chapter]")[2].scrollIntoView());
  await expect.poll(async () => (await state(page)).view).toBe("intro2");
  await page.waitForTimeout(800);
  await expect(page).toHaveScreenshot("intro-shells.png", { mask: [page.locator(".facts")] });
  await ready(page, "/?cj=d9bb6a9c&mode=encounter&t=2026-10-06T09:20:00Z&rm=1");
  await page.waitForTimeout(1500);
  await expect(page.locator(".encounter")).toHaveScreenshot("encounter-tca.png");
  await page.getByRole("button", { name: "Plan avoidance" }).click();
  await expect(page.getByRole("heading", { name: /Two avoidance options/ })).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(800);
  await expect(page.locator(".encounter")).toHaveScreenshot("plan-view.png");
});
