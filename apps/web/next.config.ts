import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: [
    "@azen/db",
    "@azen/events",
    "@azen/config",
    "@azen/agents",
    "@azen/emails",
  ],
  serverExternalPackages: ["postgres"],
};

export default nextConfig;
