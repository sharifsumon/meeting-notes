import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@minuteflow/db"],
  poweredByHeader: false,
  // deploy.sh builds into a separate folder and swaps it in, so the running app keeps serving meanwhile.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
