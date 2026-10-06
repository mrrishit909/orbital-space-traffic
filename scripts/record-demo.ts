// Records the demo scenario as a captioned video (docs/demo.webm; convert with ffmpeg to mp4). Drives the static export served by
// scripts/serve.ts on :8439 (BASE env to match). Captions are an overlay injected for the recording only.
import { chromium, type Page } from "@playwright/test";
import { mkdirSync, renameSync } from "node:fs";

const url = process.env.URL ?? "http://127.0.0.1:8439/";
const browser = await chromium.launch({ channel: "chrome", headless: process.env.HEADFUL !== "1", args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"] });
mkdirSync("docs/video", { recursive: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: "docs/video", size: { width: 1280, height: 720 } } });
const page = await ctx.newPage();
const wait = (ms: number) => page.waitForTimeout(ms);
async function caption(p: Page, text: string, ms = 3500) {
  await p.evaluate((t) => {
    let el = document.getElementById("rec-caption");
    if (!el) { el = document.createElement("div"); el.id = "rec-caption"; el.style.cssText = "position:fixed;left:50%;bottom:118px;transform:translateX(-50%);z-index:99;max-width:820px;padding:10px 16px;border-radius:10px;background:rgba(3,5,10,.88);border:1px solid #5ef2c2;color:#e6ebf2;font:15px/1.4 system-ui;text-align:center;pointer-events:none"; document.body.appendChild(el); }
    el.textContent = t;
  }, text);
  await wait(ms);
}
const st = () => page.evaluate(() => (window as unknown as { __orbital: { state: () => { load: { status: string }; plan: { status: string }; view: string } } }).__orbital.state());

await page.goto(url);
await page.waitForFunction(() => (window as unknown as { __orbital?: { state: () => { load: { status: string } } } }).__orbital?.state().load.status === "ready", null, { timeout: 60_000 });
await caption(page, "ORBITAL: a space-traffic sandbox on a synthetic catalog of 18,050 objects, propagated with SGP4 in your browser.", 5000);
const intro = page.getByLabel("Introduction");
for (let i = 0; i < 36; i++) { await intro.evaluate((el) => el.scrollBy(0, 70)); await wait(110); }
await caption(page, "Scrolling falls from deep space toward Earth. The globe turns with sidereal time and is lit by the Sun for the scene's moment.", 4500);
for (let i = 0; i < 26; i++) { await intro.evaluate((el) => el.scrollBy(0, 70)); await wait(110); }
await caption(page, "Objects appear by altitude: low Earth orbit first, then navigation orbits, then the geostationary belt. Shape marks the type.", 5000);
for (let i = 0; i < 26; i++) { await intro.evaluate((el) => el.scrollBy(0, 70)); await wait(110); }
await caption(page, "The demo operator's fleet: 60 satellites at 550 km, screened against everything for the next 24 hours.", 4500);
await page.getByRole("button", { name: "Open the operations sandbox" }).click();
await caption(page, "The story hands over to the working product: same scene, now with the conjunction list, inspector and time scrubber.", 4500);
await page.getByRole("combobox", { name: /Speed/ }).selectOption("300").catch(() => page.locator("select").first().selectOption("300"));
await page.getByRole("button", { name: "Play", exact: true }).click();
await caption(page, "Time at 300×: every object moves on its true orbit and period. Bars on the timeline count close approaches per hour.", 7000);
await page.getByRole("button", { name: "Pause", exact: true }).click();
await page.getByRole("button", { name: "Now" }).click();
await page.keyboard.press("Control+k");
await page.getByPlaceholder(/Search objects/).pressSequentially("AURORA-205", { delay: 90 });
await wait(600);
await page.keyboard.press("Enter");
await caption(page, "Selecting a satellite flies the camera into its orbital plane; the inspector shows its orbit, conjunctions and ground-station passes.", 6000);
await page.getByRole("complementary", { name: "Conjunctions" }).getByRole("button", { name: /High AURORA-205 vs R\/B/ }).click();
await caption(page, "The high-risk card: closest approach 41 m in 7 h 21 min at 5.85 km/s. Probability of collision 3.0 × 10⁻⁴.", 6000);
await caption(page, "The encounter frame is centred on the satellite and drawn in metres: the yellow ellipses are the combined 1σ and 3σ uncertainty.", 5500);
await page.getByRole("button", { name: "Play encounter" }).click();
await caption(page, "Playback at 0.2× real time: the rocket body passes through the uncertainty region, holding at closest approach.", 9000);
await page.getByRole("button", { name: "Plan avoidance" }).click();
await caption(page, "Planning: a grid of burn times with bisection on burn size, then every candidate's new orbit is re-screened against the catalog.", 3000);
await page.waitForFunction(() => (window as unknown as { __orbital: { state: () => { plan: { status: string } } } }).__orbital.state().plan.status === "done", null, { timeout: 90_000 });
await page.getByRole("complementary", { name: "Inspector" }).evaluate((el) => el.scrollTo({ top: 260, behavior: "smooth" }));
await caption(page, "The cheapest burns were rejected: they clear this conjunction but move a later pass with the same rocket body to 73–284 m.", 7500);
await caption(page, "Two clean options remain: 7.65 cm/s half an orbit early, or 16.26 cm/s a quarter orbit early. Both bring Pc to 1 × 10⁻⁶.", 6500);
await page.getByRole("radio", { name: "Choose option A" }).click();
await caption(page, "The secondary's new pass for each option appears in the encounter frame (blue and violet).", 5000);
await page.getByRole("complementary", { name: "Inspector" }).getByRole("button", { name: "Create alert rule" }).click();
await caption(page, "An alert rule: notify when Pc reaches 1 × 10⁻⁴ on the fleet within 24 hours.", 3500);
await page.getByRole("dialog").getByRole("button", { name: "Save rule" }).click();
await caption(page, "The rule is evaluated against the screened conjunctions. Here the e-mail is simulated; the Docker stack sends it to a mail sink.", 5500);
await page.getByRole("button", { name: /Failure lab/ }).click();
await page.getByRole("menuitem", { name: "Cut the element-set feed" }).click();
await caption(page, "Failure: the element-set feed goes down. The last good catalog stays usable and the client retries with backoff.", 6500);
await page.getByRole("button", { name: /Failure lab/ }).click();
await page.getByRole("menuitem", { name: "Restore the feed" }).click();
await page.getByText(/Feed recovered/).first().waitFor({ timeout: 40_000 });
await caption(page, "Feed back: element sets refreshed, nothing lost.", 4000);
await page.keyboard.press("l");
await caption(page, "Every fact in the scene is also in tables: the list view works without WebGL or motion.", 5000);
await page.keyboard.press("l");
await page.getByRole("button", { name: "Reduced motion" }).click();
await caption(page, "Reduced motion: camera travel and playback become instant state changes; information and tasks stay the same.", 5000);
await page.getByRole("button", { name: "Telemetry" }).click();
await caption(page, "Telemetry: frame rate, Web Vitals, draw calls and GPU context losses, measured live.", 5000);
await caption(page, "Synthetic data throughout. Code, tests and the write-up are on GitHub: mrrishit909/orbital-space-traffic.", 4500);
console.log(JSON.stringify(await page.evaluate(() => (window as unknown as { __orbital: { telemetry: () => unknown } }).__orbital.telemetry())));
const v = page.video();
await ctx.close();
await browser.close();
if (v) renameSync(await v.path(), "docs/video/demo.webm");
console.log("wrote docs/video/demo.webm");
