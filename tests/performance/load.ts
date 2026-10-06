// Load test: concurrent HTTP clients on the read paths, then N WebSocket live-position subscriptions held open.
// node tests/performance/load.ts [base] [httpClients] [seconds] [wsClients]
import WebSocket from "ws";

const [base = "http://127.0.0.1:8430", clients = "32", secs = "10", wsN = "2000"] = process.argv.slice(2);
const H = { authorization: "Bearer aurora-viewer-demo" };
const paths = ["/v1/conjunctions?risk=medium", "/v1/objects/70015", "/v1/objects/70015/ephemeris?from=2026-10-06T02:00:00Z&to=2026-10-06T03:00:00Z&step=30", "/v1/objects?type=debris&limit=200", "/v1/ground-stations"];
const q = (a: number[], p: number) => a.sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))];

async function http() {
  const lat: number[] = []; let errors = 0, limited = 0;
  const end = Date.now() + +secs * 1000;
  await Promise.all(Array.from({ length: +clients }, async (_, c) => {
    // each client gets its own token bucket identity via a distinct (viewer) token? there is one viewer token, so the limiter is
    // raised for the run with RATE_LIMIT; see the Makefile target
    for (let i = c; Date.now() < end; i++) {
      const t = performance.now();
      const r = await fetch(base + paths[i % paths.length], { headers: H }).catch(() => null);
      lat.push(performance.now() - t);
      if (!r) errors++; else if (r.status === 429) limited++; else if (r.status >= 400) errors++;
      await r?.arrayBuffer();
    }
  }));
  return { requests: lat.length, rps: Math.round(lat.length / +secs), p50: +q(lat, 0.5).toFixed(1), p95: +q(lat, 0.95).toFixed(1), p99: +q(lat, 0.99).toFixed(1), errors, rateLimited: limited };
}

async function ws() {
  const url = base.replace(/^http/, "ws") + "/v1/live/objects";
  let open = 0, failed = 0, messages = 0;
  const socks: WebSocket[] = [];
  const t0 = Date.now();
  await Promise.all(Array.from({ length: +wsN }, (_, k) => new Promise<void>((ok) => {
    const s = new WebSocket(url);
    socks.push(s);
    s.on("open", () => { open++; s.send(JSON.stringify({ subscribe: Array.from({ length: 10 }, (_, j) => 70001 + ((k * 10 + j) % 18000)) })); ok(); });
    s.on("message", () => { messages++; });
    s.on("error", () => { failed++; ok(); });
  })));
  const openedMs = Date.now() - t0;
  messages = 0;
  await new Promise((r) => setTimeout(r, 10_000));
  const perSec = messages / 10;
  socks.forEach((s) => s.close());
  return { requested: +wsN, open, failed, openedInMs: openedMs, messagesPerSec: Math.round(perSec), expectedPerSec: open };
}

const h = await http();
const w = await ws();
console.log(JSON.stringify({ base, httpClients: +clients, seconds: +secs, http: h, websocket: w }, null, 1));
