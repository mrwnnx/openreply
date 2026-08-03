import type { NextConfig } from "next";

// Report-Only for now: img-src has to cover Instagram avatars and media
// thumbnails, which are served from several CDN hosts and are easy to miss.
// Flip the header name to Content-Security-Policy once the dashboard has been
// walked through with an empty violation report.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://*.cdninstagram.com https://*.fbcdn.net",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  turbopack: {
    root: process.cwd(),
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // The dashboard's destructive actions (delete campaign, disconnect
          // Instagram) are one click behind a session cookie sent on top-level
          // navigation, so framing the app is enough to set up a clickjack.
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          {
            key: "Content-Security-Policy-Report-Only",
            value: CONTENT_SECURITY_POLICY,
          },
        ],
      },
    ];
  },
};

export default nextConfig;
