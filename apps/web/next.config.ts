import type { NextConfig } from "next";

// Static export: the public sandbox is plain files (GitHub Pages under /projects/orbital-space-traffic/demo, or nginx in Docker).
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const config: NextConfig = {
  output: "export",
  basePath,
  trailingSlash: true,
  images: { unoptimized: true },
  transpilePackages: ["@orbital/domain", "@orbital/motion", "@orbital/telemetry", "@orbital/sdk"],
  typescript: { ignoreBuildErrors: true }, // type-checked separately by `npm run typecheck`
  productionBrowserSourceMaps: false,
  // satellite.js's WASM loader has Node-only branches (node:module, node:worker_threads, node:fs...). They never run in the
  // browser; give webpack empty modules for them.
  webpack(config, { webpack, isServer }) {
    config.plugins.push(new webpack.NormalModuleReplacementPlugin(/pthreads-release/, new URL("./src/no-pthreads.js", import.meta.url).pathname));
    config.plugins.push(new webpack.NormalModuleReplacementPlugin(/^node:/, (r: { request: string }) => { r.request = r.request.replace(/^node:/, ""); }));
    if (!isServer) config.resolve.fallback = { ...config.resolve.fallback, module: false, worker_threads: false, fs: false, path: false, url: false, crypto: false, os: false };
    return config;
  },
};
export default config;
