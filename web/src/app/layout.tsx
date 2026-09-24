import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Visitor Insights",
  description: "Visitor, weather and holiday analytics for NZ attractions, with a natural-language SQL analyst.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-NZ">
      <body className="antialiased">{children}</body>
    </html>
  );
}
