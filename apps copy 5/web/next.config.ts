import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Disable problematic CSS optimization that crashes on WSL
  experimental: {
    cssChunking: false,
  },
  // Webpack fallback if turbopack fails
  webpack: (config) => {
    // Prevent lightningcss from being used in problematic ways
    config.resolve.alias = {
      ...config.resolve.alias,
    };
    return config;
  },
};

export default nextConfig;
