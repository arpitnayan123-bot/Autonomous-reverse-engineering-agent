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
  createdAt: string;
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
  | { type: "tool_call"; tool: string; args?: unknown }
  | { type: "tool_result"; tool: string; preview?: string }
  | { type: "assistant"; content: string }
  | { type: "error"; error: string }
  | { type: "done" }
  | { type: string; [key: string]: unknown };

// ---------------------------------------------------------------------------
// Envelope handling
// ---------------------------------------------------------------------------

interface Envelope {
  ok?: boolean;
  error?: string;
}

async function unwrap<T>(res: Response): Promise<T> {
  let json: (Envelope & Record<string, unknown>) | null = null;
  try {
    json = (await res.json()) as Envelope & Record<string, unknown>;
  } catch {
    json = null;
  }
  if (!res.ok || !json || json.ok !== true) {
    const msg =
      (json && typeof json.error === "string" && json.error) ||
      `Request failed (${res.status})`;
    throw new Error(msg);
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
 * Frames are `data: {json}\n\n`; the buffer is split on `\n\n` and every
 * `data: ` line is JSON-parsed and forwarded to `onEvent`.
 */
export async function streamChat(
  targetId: string,
  message: string,
  onEvent: (event: ChatStreamEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetId, message }),
    signal,
  });
  if (!res.ok || !res.body) {
    let msg = `Chat failed (${res.status})`;
    try {
      const json = (await res.json()) as Envelope;
      if (json && typeof json.error === "string") msg = json.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const consumeFrame = (frame: string) => {
    for (const line of frame.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        onEvent(JSON.parse(payload) as ChatStreamEvent);
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
}
