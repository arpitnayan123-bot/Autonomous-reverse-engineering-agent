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
};

export default nextConfig;
