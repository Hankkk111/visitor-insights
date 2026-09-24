import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Visitor Insights",
  description: "Visitor, weather and holiday analytics for NZ attractions, with an AI SQL analyst.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-NZ">
      <body className="antialiased">{children}</body>
    </html>
  );
}
