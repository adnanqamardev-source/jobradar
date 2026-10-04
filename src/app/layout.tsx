import type { Metadata } from "next";
import "@/app/globals.css";

export const metadata: Metadata = {
  title: "JobRadar",
  description: "Automated job finding workflow — scrape, dedupe, rank, track.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}