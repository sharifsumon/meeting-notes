import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MinuteFlow",
  description: "Meeting notes that write themselves.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
