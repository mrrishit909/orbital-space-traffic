// Data providers. The public sandbox uses StaticProvider (bundled synthetic fixtures); the Docker stack builds the web app with
// NEXT_PUBLIC_API_URL and uses ApiProvider (the real API, which reads the same fixtures from Postgres). Both can be told to fail
// (the "element-set feed outage" scenario) so the recovery path is demonstrable without breaking anything real.
import type { AlertRule, Conjunction } from "@orbital/domain";
import { traceparent } from "@orbital/telemetry";
import { OrbitalClient } from "@orbital/sdk";
import type { CompactCatalog } from "./worker/protocol.ts";

export class FeedError extends Error { status: number; constructor(status: number, msg: string) { super(msg); this.status = status; } }

export interface SavedRule extends AlertRule { id: string; createdAt: string }
export interface Delivery { ruleId: string; channel: string; target: string; text: string; delivered: "simulated" | "smtp-sink" | "queued"; at: string }

export interface DataProvider {
  readonly kind: "static" | "api";
  feedDown: boolean;
  loadCatalog(): Promise<CompactCatalog>;
  loadConjunctions(): Promise<{ epoch: string; conjunctions: Conjunction[] }>;
  saveRule(rule: AlertRule, idempotencyKey: string): Promise<{ rule: SavedRule; deliveries: Delivery[] }>;
}

const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { ...init, headers: { traceparent: traceparent(), ...(init?.headers ?? {}) } });
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try { const b = await r.json(); msg = b?.error?.message ?? msg; } catch { /* not json */ }
    throw new FeedError(r.status, msg);
  }
  return r.json() as Promise<T>;
}

export class StaticProvider implements DataProvider {
  readonly kind = "static" as const;
  feedDown = false;
  private rules: SavedRule[] = [];
  async loadCatalog() {
    if (this.feedDown) { await new Promise((r) => setTimeout(r, 400)); throw new FeedError(503, "element-set feed unavailable (simulated outage)"); }
    return getJson<CompactCatalog>(`${base}/data/catalog.json`);
  }
  async loadConjunctions() { return getJson<{ epoch: string; conjunctions: Conjunction[] }>(`${base}/data/conjunctions.json`); }
  async saveRule(rule: AlertRule, key: string) {
    const existing = this.rules.find((r) => r.id === key);
    const saved = existing ?? { ...rule, id: key, createdAt: new Date().toISOString() };
    if (!existing) this.rules.push(saved);
    return { rule: saved, deliveries: [] as Delivery[] }; // the page evaluates the rule itself and shows a simulated notification
  }
}

export class ApiProvider implements DataProvider {
  readonly kind = "api" as const;
  feedDown = false;
  private url: string;
  private client: OrbitalClient;
  constructor(url: string, token: string) { this.url = url; this.client = new OrbitalClient(url, token); }
  async loadCatalog() {
    return getJson<CompactCatalog>(`${this.url}/v1/catalog/compact${this.feedDown ? "?simulate=outage" : ""}`);
  }
  async loadConjunctions() { return this.client.conjunctions(); }
  async saveRule(rule: AlertRule, key: string) {
    return (await this.client.createAlertRule(rule, key)) as unknown as { rule: SavedRule; deliveries: Delivery[] };
  }
}

export function makeProvider(): DataProvider {
  const api = process.env.NEXT_PUBLIC_API_URL;
  return api ? new ApiProvider(api, process.env.NEXT_PUBLIC_DEMO_TOKEN ?? "aurora-operator-demo") : new StaticProvider();
}

/** Retry with exponential backoff; reports each wait so the UI can show it. */
export async function withRetry<T>(fn: () => Promise<T>, onWait: (attempt: number, ms: number, err: Error) => void, max = 6): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await fn(); } catch (e) {
      if (attempt >= max) throw e;
      const ms = Math.min(16000, 1000 * 2 ** (attempt - 1));
      onWait(attempt, ms, e as Error);
      await new Promise((r) => setTimeout(r, ms));
    }
  }
}
