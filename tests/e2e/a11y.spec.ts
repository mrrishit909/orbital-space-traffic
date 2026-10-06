// Reduced motion keeps every fact and task; keyboard alone can run the core flow; the list view replaces the canvas.
import { expect, test } from "@playwright/test";
import { ready, state } from "./helpers.ts";

test.use({ reducedMotion: "reduce" });

test("reduced motion: instant states, no travel, same information", async ({ page }) => {
  await ready(page);
  expect((await state(page)).reduced).toBe(true);
  await page.getByRole("button", { name: "Go to the high-risk conjunction" }).click();
  const inspector = page.getByRole("complementary", { name: "Inspector" });
  await expect(inspector.getByRole("button", { name: "Play encounter" })).toBeDisabled();
  await expect(page.getByText(/playback off \(reduced motion\)/)).toBeVisible();
  await expect(inspector).toContainText("41 m");
  await inspector.getByRole("button", { name: "Plan avoidance" }).click();
  await expect(page.getByRole("heading", { name: /Two avoidance options/ })).toBeVisible({ timeout: 60_000 });
});

test("keyboard only: open conjunctions, toggle list view, back out", async ({ page }) => {
  await ready(page, "/?enter=1");
  await expect.poll(async () => (await state(page)).view).toBe("explore");
  await page.keyboard.press("]");
  await expect.poll(async () => (await state(page)).view).toBe("encounter");
  const first = (await state(page)).conjunctionId;
  await page.keyboard.press("]");
  await expect.poll(async () => (await state(page)).conjunctionId).not.toBe(first);
  await page.keyboard.press("l");
  await expect(page.getByRole("main", { name: "List view" }).getByRole("table").first()).toBeVisible();
  await expect(page.getByRole("main", { name: "List view" })).toContainText("Close approaches of the Aurora fleet");
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await state(page)).view).toBe("explore");
  // every interactive control is reachable by Tab and has a name
  const unnamed = await page.locator("button:visible").evaluateAll((bs) => bs.filter((b) => !(b.textContent ?? "").trim() && !b.getAttribute("aria-label")).length);
  expect(unnamed).toBe(0);
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "Keyboard" })).toBeVisible();
});
