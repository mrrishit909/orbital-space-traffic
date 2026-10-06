import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ORBITAL · space traffic sandbox",
  description: "Interactive space-traffic and conjunction sandbox on a synthetic catalog: SGP4 in the browser, conjunction screening, collision probability, avoidance maneuvers.",
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#03050a" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
