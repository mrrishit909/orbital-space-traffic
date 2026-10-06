// The sandbox uses satellite.js's single-thread WASM runtime only; the pthreads build is replaced so it is not bundled.
export default async function unavailable() { throw new Error("multi-thread WASM runtime not bundled"); }
