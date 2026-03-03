/** @type {import('next').NextConfig} */
const internalApiPort = process.env.INTERNAL_API_PORT || "3001";

const nextConfig = {
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `http://127.0.0.1:${internalApiPort}/api/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
