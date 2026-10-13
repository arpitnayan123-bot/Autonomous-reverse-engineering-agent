import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Keep the dev-tools button out of the sidebar footer's interactive area.
  devIndicators: {
    position: "bottom-right",
  },
  // Native/WASM-capability packages must stay real Node modules (they load
  // .wasm/.node assets from the filesystem at runtime and cannot be bundled).
  serverExternalPackages: [
    "web-tree-sitter",
    "tree-sitter-wasms",
    "playwright-core",
    "@modelcontextprotocol/sdk",
    "sharp",
  ],
};

export default nextConfig;
