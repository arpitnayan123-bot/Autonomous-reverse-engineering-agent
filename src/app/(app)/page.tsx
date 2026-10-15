import type { Metadata } from "next";
import { ChatRoute } from "@/components/rea/chat-route";

/**
 * / — the landing page. Renders the current home view: the chat-first
 * workspace with the greeting dashboard as its empty state.
 */
export const metadata: Metadata = {
  title: {
    absolute: "REA Platform — Reverse Engineer Anything",
  },
  description:
    "Browser-based AI reverse-engineering platform. Upload a binary, artifact, database or app — the REA engine investigates it with evidence-backed rigor.",
};

export default function LandingPage() {
  return <ChatRoute />;
}
