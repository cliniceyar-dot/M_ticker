import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "M-Ticker — Breakout Continuation Intelligence",
  description:
    "Event intelligence + calibrated probability that a high-breakout continues without an averaging candle.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
