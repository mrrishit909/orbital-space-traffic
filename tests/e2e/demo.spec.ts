// Blueprint 01, section 17: the demo scenario, end to end, as a user would do it.
import { expect, test } from "@playwright/test";
import { ready, state } from "./helpers.ts";

test("deep space -> scrub 24 h -> fly to a satellite -> high-risk conjunction -> encounter -> two maneuvers -> alert rule", async ({ page }) => {
  await ready(page);
  // 1. opens on Earth from deep space; scrolling the story moves the camera chapter by chapter
  await expect(page.getByRole("heading", { name: /Near-Earth space/ })).toBeVisible();
  const intro = page.getByLabel("Introduction");
  for (const n of [1, 2, 3]) {
    await intro.evaluate((el, k) => el.querySelectorAll("[data-chapter]")[k].scrollIntoView(), n);
    await expect.poll(async () => (await state(page)).view).toBe(`intro${n}`);
  }
  await expect(page.getByText(/close approaches under 5 km/)).toContainText("116");
  await page.getByRole("button", { name: "Open the operations sandbox" }).click();
  await expect.poll(async () => (await state(page)).view).toBe("explore");

  // 2. scrub forward 24 hours: the clock and every object move
  const t0 = (await state(page)).simTime as number;
  const slider = page.getByRole("slider", { name: "Simulation time" });
  await slider.focus();
  await slider.press("End");
  await expect.poll(async () => (await state(page)).simTime).toBeGreaterThan(t0 + 21 * 3600e3);
  await page.getByRole("button", { name: "Now" }).click();

  // 3. select a satellite (search) and fly into its orbital plane
  await page.keyboard.press("Control+k");
  await page.getByPlaceholder(/Search objects/).fill("AURORA-205");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await state(page)).view).toBe("focus");
  await expect(page.getByRole("complementary", { name: "Inspector" })).toContainText("AURORA-205");
  await expect(page.getByText(/Ground-station passes/)).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Inspector" }).locator(".mini li").first()).toBeVisible({ timeout: 30_000 });

  // 4. trigger the high-risk conjunction card
  await page.getByRole("complementary", { name: "Conjunctions" }).getByRole("button", { name: /High AURORA-205 vs R\/B/ }).click();
  await expect.poll(async () => (await state(page)).view).toBe("encounter");
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await expect(inspector).toContainText("41 m");
  await expect(inspector).toContainText("3.0 × 10⁻⁴");

  // 5. play the encounter with its uncertainty
  await inspector.getByRole("button", { name: "Play encounter" }).click();
  await expect(page.getByText(/Closest approach: 41 m/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/combined uncertainty: 1σ and 3σ/)).toBeVisible();

  // 6. two avoidance maneuvers, compared on delta-v and risk, with re-screening
  await inspector.getByRole("button", { name: "Plan avoidance" }).click();
  await expect(page.getByRole("heading", { name: /Two avoidance options/ })).toBeVisible({ timeout: 60_000 });
  const plan = (await state(page)).plan as { options: { dvMs: number; pc: number; safe: boolean }[]; rejected: unknown[] };
  expect(plan.options).toHaveLength(2);
  expect(plan.options.every((o) => o.safe && o.pc <= 1e-6)).toBe(true);
  expect(plan.options[0].dvMs).toBeLessThan(plan.options[1].dvMs);
  await expect(page.getByText("Rejected after re-screening")).toBeVisible();
  await page.getByRole("radio", { name: "Choose option A" }).click();

  // deep link restores the plan view
  await expect.poll(() => page.url()).toContain("mode=plan");
  await expect.poll(() => page.url()).toContain("opt=a");
  const link = page.url();

  // 7. save an alert rule and show the (simulated) notification
  await inspector.getByRole("button", { name: "Create alert rule" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Save rule" }).click();
  await expect(page.getByRole("log", { name: "Notifications" })).toContainText("Simulated e-mail");
  await expect(page.getByRole("log", { name: "Notifications" })).toContainText("AURORA-205 vs R/B");

  await ready(page, link.replace("http://127.0.0.1:8439", ""));
  await expect.poll(async () => (await state(page)).view).toBe("plan");
  await expect(page.getByRole("heading", { name: /Two avoidance options/ })).toBeVisible({ timeout: 60_000 });
  await expect.poll(async () => ((await state(page)).plan as { chosen: number }).chosen).toBe(0);
});
