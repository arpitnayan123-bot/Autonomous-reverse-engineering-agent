import type { Metadata } from "next";
import { ChatSessionRoute } from "@/components/area/chat-route";
import { clipTitle, fetchRouteTitle } from "@/lib/meta";

interface Props {
  params: Promise<{ sessionId: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { sessionId } = await params;
  const title = await fetchRouteTitle(
    `/api/chat?sessionId=${encodeURIComponent(sessionId)}`,
    (json) => {
      const session = json.session as { title?: string } | undefined;
      return session?.title ?? null;
    }
  );
  return {
    title: title ? `Chat: ${clipTitle(title)}` : "Chat session",
    description: "Deep link into a AREA investigation chat.",
  };
}

export default async function ChatSessionPage({ params }: Props) {
  const { sessionId } = await params;
  return <ChatSessionRoute sessionId={sessionId} />;
}
