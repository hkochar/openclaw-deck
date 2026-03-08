import { existsSync } from "fs";
import { join } from "path";

// Guard: fail fast if bootstrap hasn't run (e.g. user ran `next dev` instead of `pnpm dev`)
const agentsConfig = join(import.meta.dirname ?? process.cwd(), "config", "deck-agents.json");
if (!existsSync(agentsConfig)) {
  console.error("\n\x1b[31mError: config/deck-agents.json not found.\x1b[0m");
  console.error("Run \x1b[1mpnpm dev\x1b[0m instead of \x1b[1mnext dev\x1b[0m — the bootstrap script creates config files automatically.\n");
  process.exit(1);
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
  reactStrictMode: true,
  productionBrowserSourceMaps: false,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
