import type { NextConfig } from "next";
import { networkInterfaces } from "node:os";

const localNetworkHosts = Object.values(networkInterfaces())
  .flat()
  .filter(
    (entry): entry is NonNullable<typeof entry> =>
      Boolean(entry && entry.family === "IPv4" && !entry.internal),
  )
  .map((entry) => entry.address);

const nextConfig: NextConfig = {
  // `next dev --hostname 0.0.0.0` cannot infer the browser-facing host.
  // Allow loopback plus every active LAN IPv4 address so Next does not block
  // its own HMR/font resources when the app is opened from another device.
  allowedDevOrigins: [...new Set(["127.0.0.1", "localhost", ...localNetworkHosts])],
  devIndicators: false,
};

export default nextConfig;
