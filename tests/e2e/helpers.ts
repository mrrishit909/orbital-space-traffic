import { expect, type Page } from "@playwright/test";

export const state = (page: Page) => page.evaluate(() => {
  const h = (window as unknown as { __orbital?: { state: () => Record<string, unknown> } }).__orbital;
  if (!h) return { view: null, load: { status: "booting" } } as Record<string, unknown>;
  const s = h.state();
  return { view: s.view, selected: s.selected, conjunctionId: s.conjunctionId, simTime: s.simTime, load: s.load, feed: s.feed, plan: s.plan, notices: (s.notices as unknown[]).length, reduced: s.reduced, listView: s.listView, webgl: s.webgl };
});
export async function ready(page: Page, url = "/") {
  await page.goto(url);
  await expect.poll(async () => (await state(page)).load, { timeout: 30_000 }).toMatchObject({ status: "ready" });
}
