"use client";

import { ChatWorkspace } from "@/components/rea/chat-workspace";
import { useShellActions } from "@/components/rea/shell-actions";

/**
 * Client body for / and /chat — a fresh chat workspace (draft state, or the
 * target-bound draft when one was just created). Shell callbacks (sidebar
 * refresh, upload picker) come from the shell context.
 */
export function ChatRoute() {
  const shell = useShellActions();
  return (
    <ChatWorkspace
      className="min-w-0 flex-1"
      onSessionsChanged={shell.refreshSessions}
      onTargetsChanged={shell.refreshTargets}
      onAttachFile={shell.openUploadPicker}
    />
  );
}

/**
 * Client body for /chat/[sessionId] — deep-linkable chat session. The
 * workspace syncs the route param into the store on mount/param change.
 */
export function ChatSessionRoute({ sessionId }: { sessionId: string }) {
  const shell = useShellActions();
  return (
    <ChatWorkspace
      className="min-w-0 flex-1"
      sessionId={sessionId}
      onSessionsChanged={shell.refreshSessions}
      onTargetsChanged={shell.refreshTargets}
      onAttachFile={shell.openUploadPicker}
    />
  );
}
