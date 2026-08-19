import type { NextConfig } from "next";

const buildCpus = Number(process.env.NEXT_BUILD_CPUS);

const nextConfig: NextConfig = {
  output: "standalone",
  ...(Number.isFinite(buildCpus) && buildCpus > 0
    ? { experimental: { cpus: buildCpus } }
    : {}),
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
