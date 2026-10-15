import * as vscode from "vscode";
import { AreaApiError } from "./api";
import type { AreaApiClient } from "./api";
import type { ChatStreamEvent, AreaProject, AreaSession, AreaTarget } from "./types";

/** Context the participant attaches to every @area question. */
export interface AreaActiveContext {
  project: AreaProject | null;
  target: AreaTarget | null;
  session: AreaSession | null;
}

export interface AreaChatParticipantDeps {
  api: AreaApiClient;
  extensionUri: vscode.Uri;
  getContext(): AreaActiveContext;
  /** Remember the session so follow-up questions continue the same thread. */
  onSessionSaved(session: AreaSession | null): void;
  isConnected(): boolean;
}

/** Participant id — users type `@area <question>` in Copilot Chat. */
export const AREA_PARTICIPANT_ID = "area.agent";

/**
 * Registers the `@area` chat participant.
 *
 * The question is forwarded to the platform's `POST /api/chat` with the
 * active project context; deltas stream token-by-token into the Copilot Chat
 * response and tool calls are surfaced as progress messages.
 */
export function registerReaChatParticipant(deps: AreaChatParticipantDeps): vscode.Disposable {
  const handler: vscode.ChatRequestHandler = async (request, _context, stream, token): Promise<vscode.ChatResult> => {
    const question = extractPrompt(request).trim();
    if (!question) {
      stream.markdown(
        "Ask me anything about your AREA projects — pick a project in the **AREA Explorer** first and I'll use it as context."
      );
      return {};
    }

    if (!deps.isConnected()) {
      stream.markdown(
        "⚠️ **Not connected to AREA.** Run `AREA: Sign In` from the Command Palette (or click the AREA item in the status bar), then ask again."
      );
      return { errorDetails: { message: "AREA extension is not connected" } };
    }

    const ctx = deps.getContext();
    const preamble: string[] = [];
    if (ctx.project) {
      preamble.push(
        `[Active project: "${ctx.project.name}" (${ctx.project.kind}${ctx.project.reference ? `: ${ctx.project.reference}` : ""})]`
      );
    }
    const message = [...preamble, question].join("\n\n");

    const abort = new AbortController();
    const cancelSub = token.onCancellationRequested(() => abort.abort());

    let sawError: string | null = null;
    try {
      for await (const event of deps.api.streamChat(
        {
          sessionId: ctx.session?.id,
          targetId: ctx.target?.id,
          message,
        },
        abort.signal
      )) {
        if (token.isCancellationRequested) break;
        renderEvent(event, stream, (session) => deps.onSessionSaved(session));
        if (event.type === "error") sawError = event.error;
      }
    } catch (err) {
      if (!token.isCancellationRequested) {
        sawError = err instanceof Error ? err.message : String(err);
        stream.markdown(`\n\n⚠️ AREA request failed: ${sawError}`);
      }
    } finally {
      cancelSub.dispose();
    }

    if (sawError) {
      if (sawError.toLowerCase().includes("unauthorized") || errStatus(sawError) === 401) {
        stream.markdown(
          "\n\n_Your session may have expired — run `AREA: Sign In` or click the AREA status bar item to reconnect._"
        );
      }
      return { errorDetails: { message: sawError } };
    }
    return {};
  };

  const participant = vscode.chat.createChatParticipant(AREA_PARTICIPANT_ID, handler);
  participant.iconPath = vscode.Uri.joinPath(deps.extensionUri, "media", "icon.png");
  participant.followupProvider = {
    provideFollowups(result, _context, _token): vscode.ChatFollowup[] {
      if (result.errorDetails) return [];
      return [
        { prompt: "Summarize what you just found", label: "Summarize findings" },
        { prompt: "What should I analyze next?", label: "Next steps" },
      ];
    },
  };
  return participant;
}

/** Map one platform SSE event onto the Copilot Chat response stream. */
function renderEvent(
  event: ChatStreamEvent,
  stream: vscode.ChatResponseStream,
  onSessionSaved: (session: AreaSession | null) => void
): void {
  switch (event.type) {
    case "session_saved":
      onSessionSaved({
        id: event.sessionId,
        title: event.title,
        targetId: event.targetId ?? null,
        pinned: false,
        targetName: null,
        detectedFormat: null,
        messageCount: 0,
        costUsd: null,
        updatedAt: new Date().toISOString(),
      });
      break;
    case "delta":
      if (event.text) stream.markdown(event.text);
      break;
    case "tool_call":
      stream.progress(`Tool ${event.tool}${argSummary(event.args)}`);
      break;
    case "tool_result":
      stream.progress(`${event.tool} done — ${shorten(event.preview, 140)}`);
      break;
    case "subagent_start":
      stream.progress(`Delegating to subagent: ${shorten(event.task, 120)}`);
      break;
    case "subagent_end":
      stream.progress(
        `Subagent ${event.status} (${event.iterations} iterations, ${event.toolsUsed} tools)`
      );
      break;
    case "error":
      stream.markdown(`\n\n⚠️ ${event.error}\n\n`);
      break;
    case "usage": {
      const bits: string[] = [];
      if (event.tokensIn != null || event.tokensOut != null) {
        bits.push(`${event.tokensIn ?? "?"}→${event.tokensOut ?? "?"} tokens`);
      }
      if (event.durationMs != null) bits.push(`${(event.durationMs / 1000).toFixed(1)}s`);
      if (event.compactionCount > 0) bits.push(`compacted ×${event.compactionCount}`);
      if (bits.length > 0) {
        stream.markdown(`\n\n<sub>${bits.join(" · ")}</sub>\n`);
      }
      break;
    }
    default:
      break; // turn_start / model / user_saved / assistant / done — no UI noise
  }
}

/** ChatRequest.prompt is `string` in stable typings; stay defensive anyway. */
function extractPrompt(request: vscode.ChatRequest): string {
  const raw: unknown = request.prompt;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    return (raw as unknown[])
      .map((part) =>
        typeof part === "string"
          ? part
          : typeof (part as { value?: unknown })?.value === "string"
            ? (part as { value: string }).value
            : ""
      )
      .join(" ");
  }
  return "";
}

function argSummary(args: unknown): string {
  if (args == null) return "";
  try {
    const s = typeof args === "string" ? args : JSON.stringify(args);
    return s ? ` — ${shorten(s, 100)}` : "";
  } catch {
    return "";
  }
}

function shorten(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function errStatus(message: string): number | null {
  const m = /HTTP (\d+)/.exec(message);
  return m ? Number(m[1]) : null;
}

export { AreaApiError };
