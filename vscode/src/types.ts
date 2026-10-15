/**
 * Types mirroring the REA platform REST API responses.
 *
 * These are intentionally structural mirrors (not imported from the server
 * code) — the extension only depends on the documented wire format of the
 * self-hosted instance, so it can be developed and packaged without the
 * platform source tree.
 */

export interface ReaUser {
  id: string;
  email: string;
  name: string | null;
  role: string;
  isDemo?: boolean;
}

export interface ReaProjectCounts {
  pages: number;
  nodes: number;
  reports: number;
  orchestrations: number;
  verifications: number;
}

export interface ReaProject {
  id: string;
  /** "website" | "github" | "file" */
  kind: string;
  name: string;
  /** https URL, "owner/repo", or "targets/<id>" for file projects */
  reference: string;
  description: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  counts: ReaProjectCounts;
}

export interface ReaTargetRun {
  id: string;
  status: string;
  progress: number;
  currentStep: string | null;
  findingsCount: number;
  evidenceCount: number;
  createdAt: string;
}

export interface ReaTarget {
  id: string;
  originalName: string;
  sizeBytes: number;
  detectedFormat: string | null;
  formatFamily: string | null;
  status: string;
  summary: string | null;
  createdAt: string;
  lastRun: ReaTargetRun | null;
}

export interface ReaSession {
  id: string;
  title: string;
  targetId: string | null;
  pinned: boolean;
  targetName: string | null;
  detectedFormat: string | null;
  messageCount: number;
  costUsd: number | null;
  updatedAt: string;
}

export interface ReaMessage {
  id: string;
  role: string;
  content: string;
  /** Raw JSON string: `{ tool: string; args?: Record<string, unknown>; result?: string }[]` */
  toolCalls: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  durationMs: number | null;
  modelId: string | null;
  createdAt: string;
}

export interface ReaSessionDetail {
  session: {
    id: string;
    title: string;
    targetId: string | null;
    targetName: string | null;
    detectedFormat: string | null;
  };
  messages: ReaMessage[];
  total: number;
  hasMore: boolean;
}

export interface ReaUploadResult {
  id: string;
  originalName: string;
  sizeBytes: number;
  sha256: string;
  detectedFormat: string | null;
  formatFamily: string | null;
  formatLabel: string | null;
  status: string;
  createdAt: string;
}

/** One parsed Server-Sent-Event emitted by POST /api/chat. */
export type ChatStreamEvent =
  | { type: "session_saved"; sessionId: string; title: string; targetId: string | null }
  | { type: "user_saved"; messageId: string }
  | { type: "model"; modelId?: string; label?: string; [k: string]: unknown }
  | { type: "turn_start"; turn: number }
  | { type: "delta"; text: string }
  | { type: "tool_call"; tool: string; args: unknown }
  | { type: "tool_result"; tool: string; preview: string }
  | {
      type: "subagent_start";
      id: string;
      task: string;
      tools: number;
      maxIterations: number;
    }
  | { type: "subagent_delta"; id: string; text: string }
  | {
      type: "subagent_end";
      id: string;
      status: string;
      durationMs: number;
      iterations: number;
      toolsUsed: number;
      summary: string | null;
    }
  | {
      type: "usage";
      tokensIn: number | null;
      tokensOut: number | null;
      durationMs: number | null;
      modelId: string | null;
      compactionCount: number;
    }
  | { type: "assistant"; content: string }
  | { type: "error"; error: string }
  | { type: "done" };

export interface StreamChatBody {
  sessionId?: string;
  targetId?: string;
  message: string;
}
