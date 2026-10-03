import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  // Design decision (docs/04 §5): only our own origins plus documented
  // third-party asset hosts. Anything else is a bug.
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "cdn.supabase.co" },
      { protocol: "https", hostname: "logo.clearbit.com" },
    ],
  },

  // Restrictive headers — docs/03 §4.5
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
