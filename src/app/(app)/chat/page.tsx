import type { Metadata } from "next";
import { ChatRoute } from "@/components/area/chat-route";

/** /chat — the chat workspace (fresh chat; target drafts land here too). */
export const metadata: Metadata = {
  title: "Chat",
  description:
    "Investigate with the AREA agent: stream answers, tool runs and evidence in a dedicated chat workspace.",
};

export default function ChatPage() {
  return <ChatRoute />;
}
