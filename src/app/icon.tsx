import { ImageResponse } from "next/og";

// Replaces the default Next.js favicon with the brand mark — Hostinger
// violet rounded square + white chat-square glyph — matching the
// sidebar logo in `src/components/layout/sidebar.tsx`. Next.js renders
// this at build time and auto-injects <link rel="icon"> into <head>.
//
// This route takes precedence over src/app/favicon.ico, which is the
// Next.js default and can stay on disk harmlessly (or be removed).

export const runtime = "edge";
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#18191B",
          borderRadius: 8,
          border: "1.5px solid #ADC902",
        }}
      >
        <span
          style={{
            fontSize: 20,
            fontWeight: 900,
            fontFamily: "system-ui, sans-serif",
            color: "#ADC902",
            letterSpacing: -1,
            lineHeight: 1,
          }}
        >
          U
        </span>
      </div>
    ),
    { ...size },
  );
}
