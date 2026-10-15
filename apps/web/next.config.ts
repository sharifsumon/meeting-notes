import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@minuteflow/db"],
  poweredByHeader: false,
};

export default nextConfig;
