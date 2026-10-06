// Promise-based wrapper around the propagation worker.
import type { FromWorker, ToWorker } from "./protocol.ts";

type Req = ToWorker extends infer T ? (T extends { id: number } ? Omit<T, "id"> : never) : never;

export class PropagationClient {
  private w: Worker;
  private seq = 0;
  private waiting = new Map<number, { ok: (m: FromWorker) => void; err: (e: Error) => void; progress?: (stage: string, f: number) => void }>();
  ready: Promise<{ n: number; wasm: boolean; ms: number }>;

  constructor(init: Extract<ToWorker, { type: "init" }>) {
    this.w = new Worker(new URL("./propagation.worker.ts", import.meta.url), { type: "module" });
    let resolveReady!: (v: { n: number; wasm: boolean; ms: number }) => void;
    this.ready = new Promise((r) => (resolveReady = r));
    this.w.onmessage = (ev: MessageEvent<FromWorker>) => {
      const m = ev.data;
      if (m.type === "ready") return resolveReady(m);
      const h = this.waiting.get(m.id);
      if (!h) return;
      if (m.type === "progress") return h.progress?.(m.stage, m.fraction);
      this.waiting.delete(m.id);
      if (m.type === "error") h.err(new Error(m.message)); else h.ok(m);
    };
    this.w.postMessage(init);
  }

  call<T extends FromWorker["type"]>(req: Req, progress?: (stage: string, f: number) => void): Promise<Extract<FromWorker, { type: T }>> {
    const id = ++this.seq;
    return new Promise((ok, err) => {
      this.waiting.set(id, { ok: ok as (m: FromWorker) => void, err, progress });
      this.w.postMessage({ ...req, id });
    });
  }

  terminate() { this.w.terminate(); }
}
