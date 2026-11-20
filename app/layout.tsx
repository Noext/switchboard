import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Switchboard",
  description: "Passerelle MCP unique — agrégation, droits par clé, observabilité",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#0b0f14",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
