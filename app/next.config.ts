import type { NextConfig } from "next";
import path from "node:path";
import webpack from "webpack";

const nextConfig: NextConfig = {
  output: "export",
  reactStrictMode: true,
  outputFileTracingRoot: path.join(__dirname, "../../"),
  images: { unoptimized: true }, // required for static export (no Next.js image server)
  webpack: (config) => {
    // Provide Buffer + process polyfills for client bundles. @solana/web3.js
    // and @coral-xyz/anchor rely on Node globals that Next 15 doesn't ship
    // automatically for browser contexts.
    config.plugins.push(
      new webpack.ProvidePlugin({
        Buffer: ["buffer", "Buffer"],
        process: "process/browser",
      })
    );
    config.resolve.fallback = {
      ...(config.resolve.fallback ?? {}),
      buffer: require.resolve("buffer/"),
      crypto: false,
      stream: false,
      fs: false,
    };
    return config;
  },
};

export default nextConfig;
