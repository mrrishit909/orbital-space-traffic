// Encounter playback clock: simulated seconds relative to TCA, advanced by its own deterministic script (journey.PLAYBACK).
import { PLAYBACK, playbackPhase, type Playback } from "../journey.ts";

export const encounterClock = { t: PLAYBACK.fromS, playing: false, holdLeft: 0, phase: "idle" as Playback };

/** Step the script. Returns the phase after the step. Same inputs, same sequence (tested). */
export function stepEncounter(dtMs: number, reduced: boolean): Playback {
  const c = encounterClock;
  if (!c.playing) return c.phase;
  if (reduced) { c.t = 0; c.playing = false; c.phase = "closest"; return c.phase; } // reduced motion: show the closest approach, no travel
  if (c.holdLeft > 0) { c.holdLeft -= dtMs; c.phase = "closest"; return c.phase; }
  const before = c.t;
  c.t = Math.min(PLAYBACK.toS, c.t + (dtMs / 1000) * PLAYBACK.rate);
  if (before < 0 && c.t >= 0) { c.t = 0; c.holdLeft = PLAYBACK.holdMs; }
  c.phase = playbackPhase(c.t, c.holdLeft > 0);
  if (c.t >= PLAYBACK.toS) { c.playing = false; c.phase = "done"; }
  return c.phase;
}

export function playEncounter() { Object.assign(encounterClock, { t: PLAYBACK.fromS, playing: true, holdLeft: 0, phase: "approach" }); }
