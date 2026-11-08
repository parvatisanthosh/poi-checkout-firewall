/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@poi/shared", "@poi/agent"],
};

export default nextConfig;
