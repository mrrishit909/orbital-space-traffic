// The product's view states as deterministic machines (packages/motion). The store asks the machine which view follows an event;
// the scene then animates toward the camera/layer targets of that view. Reduced motion changes how fast, never where.
import { transition, type MachineDef } from "@orbital/motion";

export type View = "intro0" | "intro1" | "intro2" | "intro3" | "explore" | "focus" | "encounter" | "plan";
export type JourneyEvent =
  | { type: "CHAPTER"; n: number }
  | { type: "ENTER" }
  | { type: "SELECT" }
  | { type: "OPEN_CONJUNCTION" }
  | { type: "PLAN" }
  | { type: "BACK" }
  | { type: "CLEAR" };

const intro = (n: number): View => (["intro0", "intro1", "intro2", "intro3"] as const)[Math.max(0, Math.min(3, n))];
const introState = { on: { CHAPTER: (e: { n: number }) => intro(e.n), ENTER: "explore" as View, OPEN_CONJUNCTION: "encounter" as View, SELECT: "focus" as View } };

export const journey: MachineDef<View, JourneyEvent> = {
  initial: "intro0",
  states: {
    intro0: introState, intro1: introState, intro2: introState, intro3: introState,
    explore: { on: { SELECT: "focus", OPEN_CONJUNCTION: "encounter", CHAPTER: (e) => intro(e.n) } },
    focus: { on: { SELECT: "focus", OPEN_CONJUNCTION: "encounter", BACK: "explore", CLEAR: "explore" } },
    encounter: { on: { PLAN: "plan", BACK: "focus", CLEAR: "explore", SELECT: "focus", OPEN_CONJUNCTION: "encounter" } },
    plan: { on: { BACK: "encounter", CLEAR: "explore", OPEN_CONJUNCTION: "encounter", SELECT: "focus" } },
  },
};
export const next = (v: View, e: JourneyEvent) => transition(journey, v, e);
export const isIntro = (v: View) => v.startsWith("intro");

/** Encounter playback: a fixed script on its own clock (seconds of simulated time relative to TCA). */
export type Playback = "idle" | "approach" | "closest" | "depart" | "done";
export const PLAYBACK = { fromS: -0.8, toS: 0.8, rate: 0.2, holdMs: 1200 }; // 0.2x real time, hold 1.2 s at closest approach
export function playbackPhase(tRel: number, holding: boolean): Playback {
  if (holding) return "closest";
  if (tRel <= PLAYBACK.fromS) return "idle";
  if (tRel < 0) return "approach";
  if (tRel < PLAYBACK.toS) return "depart";
  return "done";
}
