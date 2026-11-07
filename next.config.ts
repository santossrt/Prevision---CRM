import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // Preserve the canonical loopback IP in proxy redirects and OAuth requests.
  skipProxyUrlNormalize: true,
  logging: { incomingRequests: false },
  serverExternalPackages: ["@prisma/adapter-pg", "pg", "exceljs", "yauzl", "pdfmake", "nodemailer-smtp"],
  outputFileTracingIncludes: {
    "/api/transfers/exports/*/download": ["./node_modules/pdfmake/fonts/Roboto/**/*", "./node_modules/pdfmake/fonts/Roboto.js"]
  },
  outputFileTracingExcludes: { "/*": ["./.cache/**/*"] },
  async headers() {
    return [{
      source: "/(.*)",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" }
      ]
    }];
  }
};

export default nextConfig;
