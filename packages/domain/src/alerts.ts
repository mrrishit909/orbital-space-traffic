// Alert rules: which conjunctions should notify an operator. Evaluated the same way in the API and in the browser sandbox.
import type { Conjunction } from "./conjunctions.ts";

export interface AlertRule {
  id?: string;
  name: string;
  /** "fleet" = any object the operator owns; otherwise an explicit list of NORAD ids */
  scope: "fleet" | number[];
  minPc: number;
  maxMissM?: number;
  /** only conjunctions whose TCA is within this many hours of evaluation time */
  withinHours: number;
  channel: "email" | "webhook";
  target: string;
}

export function validateRule(r: unknown): string[] {
  const e: string[] = [];
  const x = r as Partial<AlertRule>;
  if (!x || typeof x !== "object") return ["rule must be an object"];
  if (!x.name || typeof x.name !== "string" || x.name.length > 80) e.push("name: 1-80 characters");
  if (!(x.scope === "fleet" || (Array.isArray(x.scope) && x.scope.length > 0 && x.scope.every((n) => Number.isInteger(n))))) e.push("scope: 'fleet' or a list of NORAD ids");
  if (typeof x.minPc !== "number" || !(x.minPc > 0 && x.minPc <= 1)) e.push("minPc: number in (0, 1]");
  if (x.maxMissM !== undefined && !(typeof x.maxMissM === "number" && x.maxMissM > 0)) e.push("maxMissM: positive number");
  if (typeof x.withinHours !== "number" || !(x.withinHours > 0 && x.withinHours <= 168)) e.push("withinHours: 0-168");
  if (x.channel !== "email" && x.channel !== "webhook") e.push("channel: email or webhook");
  if (typeof x.target !== "string" || (x.channel === "email" ? !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x.target) : !/^https:\/\//.test(x.target))) e.push("target: e-mail address or https URL");
  return e;
}

export function matches(rule: AlertRule, cs: Conjunction[], fleet: Set<number>, now: Date): Conjunction[] {
  const inScope = (n: number) => (rule.scope === "fleet" ? fleet.has(n) : rule.scope.includes(n));
  const horizon = now.getTime() + rule.withinHours * 3600e3;
  return cs.filter((c) => inScope(c.primaryNorad) && c.pc >= rule.minPc && (rule.maxMissM === undefined || c.missM <= rule.maxMissM)
    && Date.parse(c.tca) >= now.getTime() && Date.parse(c.tca) <= horizon);
}

export function notificationText(rule: AlertRule, c: Conjunction, names: Map<number, string>) {
  return `[ORBITAL demo] ${rule.name}: ${names.get(c.primaryNorad)} vs ${names.get(c.secondaryNorad)} at ${c.tca.replace(".000Z", "Z")}, miss ${Math.round(c.missM)} m, Pc ${c.pc.toExponential(1)} (synthetic data)`;
}
