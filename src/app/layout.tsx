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
    icon: "/logo.svg",
  },
  openGraph: {
    title: "REA Platform — Reverse Engineer Anything",
    description:
      "Professional reverse engineering, as easy as chatting with an AI.",
    siteName: "REA Platform",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "REA Platform — Reverse Engineer Anything",
    description: "Evidence-first AI reverse engineering in the browser.",
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
