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
  title: "AREA — Autonomous reverse engineering agent",
  description:
    "AREA is an autonomous reverse engineering agent: upload a binary, artifact, database or app — the engine investigates it with 170 real tools and evidence-backed rigor.",
  keywords: [
    "AREA",
    "reverse engineering",
    "binary analysis",
    "evidence-first",
    "MCP",
    "AI agent",
  ],
  icons: {
    icon: "/area-logo-256.png",
    apple: "/area-logo-180.png",
  },
  openGraph: {
    title: "AREA — Autonomous reverse engineering agent",
    description:
      "Professional reverse engineering, as easy as chatting with an AI.",
    siteName: "AREA",
    type: "website",
    images: [
      {
        url: "/area-logo.png",
        width: 1024,
        height: 1024,
        alt: "AREA — Autonomous reverse engineering agent",
      },
    ],
  },
  twitter: {
    card: "summary",
    title: "AREA — Autonomous reverse engineering agent",
    description: "Evidence-first AI reverse engineering in the browser.",
    images: ["/area-logo.png"],
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
