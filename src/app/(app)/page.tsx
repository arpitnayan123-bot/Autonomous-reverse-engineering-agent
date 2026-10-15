import type { Metadata } from "next";
import { ChatRoute } from "@/components/area/chat-route";

/**
 * / — the landing page. Renders the current home view: the chat-first
 * workspace with the greeting dashboard as its empty state.
 */
export const metadata: Metadata = {
  title: {
    absolute: "AREA — Autonomous reverse engineering agent",
  },
  description:
    "AREA is an autonomous reverse engineering agent: upload a binary, artifact, database or app — the engine investigates it with 170 real tools and evidence-backed rigor.",
};

export default function LandingPage() {
  return <ChatRoute />;
}
