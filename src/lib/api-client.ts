/**
 * REA Platform — typed API client.
 * Every endpoint returns `{ ok: true, ...payload }` or `{ ok: false, error }`.
 * Helpers unwrap the envelope and throw `Error(error)` on failure so callers
 * can surface failures with toasts.
 */

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface ReaUser {
  id: string;
  email: string;
  name: string;
  role: string;
  isDemo?: boolean;
}

// ---------------------------------------------------------------------------
// BYOK AI provider types
// ---------------------------------------------------------------------------

export interface ProviderModelInfo {
  id: string;
  label: string;
  note?: string;
}

export interface ProviderInfo {
  id: string;
  label: string;
  vendor: string;
  docsHint: string;
  models: ProviderModelInfo[];
}

export interface ProviderActive {
  provider: string;
  model: string;
  keyLast4?: string;
  keyMasked?: string;
  verified?: boolean;
  updatedAt?: string;
}

export interface ProviderCatalog {
  providers: ProviderInfo[];
  active: ProviderActive | null;
}

export interface RunSummary {
  id: string;
  status: string;
  progress: number;
  currentStep: string | null;
  createdAt: string;
}

export interface TargetSummary {
  id: string;
  originalName: string;
  sizeBytes: number;
  detectedFormat: string;
  formatFamily: string;
  status: string;
  summary: string | null;
  createdAt: string;
  lastRun: RunSummary | null;
}

export interface Run {
  id: string;
  status: string;
  progress: number;
  currentStep: string | null;
  durationMs: number | null;
  createdAt: string;
  finishedAt: string | null;
  error: string | null;
  result: unknown;
}

export interface TargetDetail extends TargetSummary {
  sha256: string;
  formatLabel?: string;
  formatConfidence?: string;
  formatDetails?: string;
  /** AI-generated RE documentation (GET /api/targets/[id] returns it). */
  docs?: string;
  runs: Run[];
}

export interface Finding {
  id: string;
  type: string;
  name: string;
  address: string | null;
  sizeBytes: number | null;
  meta: string | null;
  createdAt: string;
}

export interface EvidenceRow {
  id: string;
  evidenceId: string;
  kind: "observed" | "derived" | "inferred" | "unknown" | string;
  predicateType: string | null;
  operation: string;
  subjectName: string | null;
  confidence: number | string | null;
  authority: string | null;
  payload: string; // JSON string
  createdAt: string;
}

export interface ChatMessageRow {
  id: string;
  role: "user" | "assistant" | string;
  content: string;
  toolCalls: string | null; // JSON string
  /** Provider-reported tokens (assistant rows; null = unknown). */
  tokensIn?: number | null;
  tokensOut?: number | null;
  /** Wall-clock agent turn duration in ms (assistant rows). */
  durationMs?: number | null;
  /** Canonical model id for this turn ("openai/gpt-4o-mini" | "glm-platform"). */
  modelId?: string | null;
  createdAt: string;
}

/** Sidebar row for a chat session (GET /api/chat). */
export interface SessionSummary {
  id: string;
  title: string;
  targetId: string | null;
  pinned: boolean;
  targetName: string | null;
  detectedFormat: string | null;
  messageCount: number;
  /** Cumulative cost estimate (USD) from provider tokens × per-turn model pricing; null = unknown. */
  costUsd?: number | null;
  updatedAt: string;
}

/** Detail for one session (GET /api/chat?sessionId=). */
export interface ChatSessionDetail {
  id: string;
  title: string;
  targetId: string | null;
  targetName: string | null;
  detectedFormat: string | null;
}

export interface ChatSession {
  id: string;
  title: string | null;
}

export interface Capabilities {
  engine: {
    version: string;
    toolCount: number;
    healthy: boolean;
    detail: string | null;
  };
  tools: { name: string; title: string; description?: string }[];
  hostTools: { name: string; available: boolean }[];
  providers: { native: false; reason: string };
}

export interface HexRow {
  offset: number;
  bytes: number[];
  ascii: string;
}

export interface HexPage {
  offset: number;
  length: number;
  fileSize: number;
  hex: HexRow[];
}

export interface StringsPage {
  strings: { offset: number; value: string; encoding: string }[];
  total: number;
  page: number;
  pageSize: number;
}

/** One live (unrevoked) login session, as shown in the security view. */
export interface AuthSessionInfo {
  id: string;
  createdAt: string;
  ip: string | null;
  userAgent: string | null;
  /** True for the session this browser is currently using. */
  current: boolean;
}

export interface SecurityData {
  posture: { control: string; status: string; detail: string }[];
  engineDiag: { running: boolean; stderr: string | null };
  recentThreats: {
    id: string;
    action: string;
    detail: string;
    severity: string;
    createdAt: string;
  }[];
  sessions?: AuthSessionInfo[];
}

export interface AuditEvent {
  id: string;
  action: string;
  detail: string;
  severity: string;
  ip: string | null;
  createdAt: string;
}

export type ChatStreamEvent =
  | { type: "session_saved"; sessionId: string; title: string; targetId: string | null }
  | { type: "user_saved"; messageId: string }
  | { type: "model"; source: string; provider: string; model: string }
  | { type: "turn_start"; turn: number }
  | { type: "delta"; text: string }
  | { type: "tool_call"; tool: string; args?: unknown }
  | { type: "tool_result"; tool: string; preview?: string }
  | {
      type: "usage";
      tokensIn: number | null;
      tokensOut: number | null;
      durationMs: number;
      /** Canonical model id that produced this turn (persisted server-side). */
      modelId?: string;
    }
  | { type: "assistant"; content: string }
  | { type: "error"; error: string }
  | { type: "done" }
  // Tolerate any future/unknown event type without breaking consumers.
  | { type: "<unknown>" };

// ---------------------------------------------------------------------------
// Chat sessions
// ---------------------------------------------------------------------------

/** GET /api/chat — list the signed-in user's sessions, pinned first. */
export async function listChatSessions(): Promise<SessionSummary[]> {
  const res = await apiGet<{ sessions: SessionSummary[] }>("/api/chat");
  return res.sessions;
}

/** GET /api/chat?sessionId= — session detail + full message history. */
/** Shape of GET /api/chat?sessionId= — a paged window over one session. */
export interface ChatHistoryResponse {
  session: ChatSessionDetail;
  messages: ChatMessageRow[];
  /** Total persisted messages in the session. */
  total: number;
  /** True when older messages exist beyond this window (load via all=1). */
  hasMore: boolean;
}

export async function getChatSession(
  sessionId: string,
  opts?: { all?: boolean }
): Promise<ChatHistoryResponse> {
  return apiGet<ChatHistoryResponse>("/api/chat", {
    sessionId,
    ...(opts?.all ? { all: "1" } : {}),
  });
}

/** DELETE /api/chat?sessionId= — delete one session. */
export async function deleteChatSession(sessionId: string): Promise<void> {
  await apiDelete(`/api/chat?sessionId=${encodeURIComponent(sessionId)}`);
}

/** PATCH /api/chat?sessionId= — rename a session. */
export async function renameChatSession(sessionId: string, title: string): Promise<void> {
  await apiPatch(`/api/chat?sessionId=${encodeURIComponent(sessionId)}`, { title });
}

/** PATCH /api/chat?sessionId= — pin or unpin a session. */
export async function setChatSessionPinned(sessionId: string, pinned: boolean): Promise<void> {
  await apiPatch(`/api/chat?sessionId=${encodeURIComponent(sessionId)}`, { pinned });
}

/** POST /api/chat/fork — branch a new chat that copies history up to a message. */
export async function forkChatSession(
  sessionId: string,
  messageId: string
): Promise<SessionSummary> {
  const res = await apiPost<{ session: SessionSummary }>("/api/chat/fork", {
    sessionId,
    messageId,
  });
  return res.session;
}

/** One message match from the server-side content search. */
export interface MessageSearchHit {
  messageId: string;
  sessionId: string;
  sessionTitle: string;
  targetName: string | null;
  detectedFormat: string | null;
  role: "user" | "assistant";
  snippet: string;
  createdAt: string;
}

/** GET /api/chat/search?q= — search message content across all sessions. */
export async function searchChatMessages(q: string): Promise<MessageSearchHit[]> {
  const res = await apiGet<{ results: MessageSearchHit[] }>("/api/chat/search", { q });
  return res.results;
}

// ---------------------------------------------------------------------------
// Envelope handling
// ---------------------------------------------------------------------------

interface Envelope {
  ok?: boolean;
  error?: string;
}

/** Fired whenever an authenticated endpoint answers 401 mid-session so the
 * app can return to the sign-in screen instead of stranding the user in a
 * broken shell with cryptic toasts (stale cookie, revoked session, rotated
 * signing secret). */
export function notifySessionExpired(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("rea:session-expired"));
  }
}

async function unwrap<T>(res: Response): Promise<T> {
  let json: (Envelope & Record<string, unknown>) | null = null;
  try {
    json = (await res.json()) as Envelope & Record<string, unknown>;
  } catch {
    json = null;
  }
  if (!res.ok || !json || json.ok !== true) {
    const serverMsg = json && typeof json.error === "string" ? json.error : null;
    if (res.status === 401) {
      notifySessionExpired();
      throw new Error(serverMsg ?? "Your session expired — sign in again");
    }
    throw new Error(serverMsg ?? `Request failed (${res.status})`);
  }
  return json as T;
}

function buildUrl(path: string, params?: Record<string, string | number | undefined | null>) {
  if (!params) return path;
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    qs.set(key, String(value));
  }
  const suffix = qs.toString();
  return suffix ? `${path}?${suffix}` : path;
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

export async function apiGet<T>(
  path: string,
  params?: Record<string, string | number | undefined | null>
): Promise<T> {
  const res = await fetch(buildUrl(path, params), { cache: "no-store" });
  return unwrap<T>(res);
}

export async function apiPost<T>(
  path: string,
  body?: unknown
): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
    cache: "no-store",
  });
  return unwrap<T>(res);
}

export async function apiDelete<T>(path: string): Promise<T> {
  const res = await fetch(path, { method: "DELETE", cache: "no-store" });
  return unwrap<T>(res);
}

export async function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
    cache: "no-store",
  });
  return unwrap<T>(res);
}

/**
 * Multipart upload with progress reporting (XMLHttpRequest — fetch cannot
 * report upload progress).
 */
export function apiUpload<T>(
  path: string,
  formData: FormData,
  onProgress?: (percent: number) => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", path);
    xhr.responseType = "text";
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.min(100, Math.round((e.loaded / e.total) * 100)));
      }
    };
    xhr.onload = () => {
      let json: (Envelope & Record<string, unknown>) | null = null;
      try {
        json = JSON.parse(xhr.responseText) as Envelope & Record<string, unknown>;
      } catch {
        json = null;
      }
      if (xhr.status >= 200 && xhr.status < 300 && json && json.ok === true) {
        onProgress?.(100);
        resolve(json as T);
      } else {
        const msg =
          (json && typeof json.error === "string" && json.error) ||
          `Upload failed (${xhr.status})`;
        reject(new Error(msg));
      }
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.onabort = () => reject(new Error("Upload aborted"));
    xhr.send(formData);
  });
}

// ---------------------------------------------------------------------------
// Chat SSE streaming
// ---------------------------------------------------------------------------

/**
 * POSTs a chat message and consumes the SSE response.
 * - `sessionId`  → continue an existing session.
 * - `targetId`   → start a NEW chat bound to that target (no sessionId).
 * - neither      → start a NEW free chat.
 * - `editMessageId` → edit-and-resend that user turn (truncates after it).
 * - `regenerate`    → re-run the last user turn (drops the last reply).
 * Frames are `data: {json}\n\n`; the buffer is split on `\n\n` and every
 * `data: ` line is JSON-parsed and forwarded to `onEvent`.
 * Resolves with the message quota remaining (from X-RateLimit-Remaining).
 */
export async function streamChat(
  opts: {
    sessionId?: string | null;
    targetId?: string | null;
    message: string;
    editMessageId?: string | null;
    regenerate?: boolean;
    onEvent: (event: ChatStreamEvent) => void;
  },
  signal?: AbortSignal
): Promise<{ rateLimitRemaining: number | null }> {
  const { sessionId, targetId, message, editMessageId, regenerate, onEvent } = opts;
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: sessionId ?? undefined,
      targetId: targetId ?? undefined,
      message,
      editMessageId: editMessageId ?? undefined,
      regenerate: regenerate || undefined,
    }),
    signal,
  });
  // `Number(null) === 0` — a missing header must stay null, not "quota
  // exhausted", or every chat looks rate-limited when a proxy strips it.
  const remainingRaw = res.headers.get("X-RateLimit-Remaining");
  const rateLimitRemaining =
    remainingRaw === null || remainingRaw.trim() === ""
      ? null
      : Number(remainingRaw);
  if (!res.ok || !res.body) {
    let msg = `Chat failed (${res.status})`;
    try {
      const json = (await res.json()) as Envelope;
      if (json && typeof json.error === "string") msg = json.error;
    } catch {
      /* ignore */
    }
    if (res.status === 401) {
      notifySessionExpired();
      throw new Error(msg === `Chat failed (${res.status})` ? "Your session expired — sign in again" : msg);
    }
    throw new Error(msg);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  /**
   * A stream that ends WITHOUT the terminal frame (done | error) did NOT
   * finish — the connection was cut mid-answer (proxy idle timeout, network
   * drop). Resolving silently would strand the user with a half answer and
   * no explanation; throw an explicit, honest error instead. The caller
   * keeps the already-streamed partial content (error is merged into the
   * entry, content untouched).
   */
  let sawTerminal = false;
  const trackedOnEvent = (ev: ChatStreamEvent) => {
    if (ev.type === "done" || ev.type === "error") sawTerminal = true;
    onEvent(ev);
  };

  const consumeFrame = (frame: string) => {
    for (const line of frame.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        trackedOnEvent(JSON.parse(payload) as ChatStreamEvent);
      } catch {
        // Malformed frame — ignore, keep the stream alive.
      }
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      consumeFrame(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
    }
  }
  // Flush any trailing frame that was not \n\n-terminated.
  if (buffer.trim()) consumeFrame(buffer);
  if (!sawTerminal) {
    throw new Error(
      "The connection dropped before the model finished (no completion frame). Your partial answer is preserved — resend the message or use Regenerate to continue."
    );
  }
  return {
    rateLimitRemaining: Number.isFinite(rateLimitRemaining) ? rateLimitRemaining : null,
  };
}
