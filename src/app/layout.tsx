import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"
  ),
  title: "REA Platform — Reverse Engineer Anything",
  description:
    "Browser-based AI reverse-engineering platform. Upload a binary, artifact, database or app — the REA engine investigates it with evidence-backed rigor.",
  keywords: [
    "REA",
    "reverse engineering",
    "binary analysis",
    "evidence-first",
    "MCP",
    "AI agent",
  ],
  icons: {
    icon: "/rea-logo-256.png",
    apple: "/rea-logo-180.png",
  },
  openGraph: {
    title: "REA Platform — Reverse Engineer Anything",
    description:
      "Professional reverse engineering, as easy as chatting with an AI.",
    siteName: "REA Platform",
    type: "website",
    images: [
      {
        url: "/rea-logo.png",
        width: 1024,
        height: 1024,
        alt: "REA — Reverse Engineer Anything",
      },
    ],
  },
  twitter: {
    card: "summary",
    title: "REA Platform — Reverse Engineer Anything",
    description: "Evidence-first AI reverse engineering in the browser.",
    images: ["/rea-logo.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
