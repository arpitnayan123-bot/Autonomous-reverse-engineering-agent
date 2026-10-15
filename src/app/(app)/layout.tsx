import type { Metadata } from "next";
import { AppShellLoader } from "@/components/rea/app-shell-loader";

/**
 * Shared layout for every workspace route (/, /chat, /projects, /targets,
 * /settings, /admin): boots the session, renders the app chrome (top bar,
 * sidebar, inspector, palette, dialogs) once, and mounts the active route as
 * its main content. Route-level titles use the `template` so each page only
 * declares its own name.
 */
export const metadata: Metadata = {
  title: {
    default: "REA Platform — Reverse Engineer Anything",
    template: "%s — REA",
  },
};

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <AppShellLoader>{children}</AppShellLoader>;
}
