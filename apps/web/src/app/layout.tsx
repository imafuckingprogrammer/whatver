import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Embeddable AI Agent",
  description: "Paste one script tag. Your website now has an AI employee.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
