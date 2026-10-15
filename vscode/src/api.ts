/**
 * AREA platform REST API client.
 *
 * Deliberately framework-free (no `vscode` import) so it can be reasoned
 * about and reused on its own. Authentication model:
 *
 *  1. `login()` POSTs email/password to `/api/auth/login`. The platform
 *     answers with an HMAC-signed session token in a `Set-Cookie: area_session=
 *     …` header (HttpOnly — browsers never see it in JS, so there is no
 *     first-party token endpoint to call).
 *  2. The extension stores that token in VS Code secret storage and replays
 *     it as a `Cookie: area_session=…` header on every request — exactly what
 *     the platform's session verifier reads.
 *  3. Chat uses `POST /api/chat` (Server-Sent Events). Frames are
 *     `data: {json}\n\n`; comment frames (`: ping`) are keepalives and are
 *     skipped.
 */

import type {
  ChatStreamEvent,
  AreaMessage,
  AreaProject,
  AreaSession,
  AreaSessionDetail,
  AreaTarget,
  AreaUploadResult,
  AreaUser,
  StreamChatBody,
} from "./types";

/** Platform-reported upload cap (see server: MAX_UPLOAD_BYTES = 50 MB). */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export class AreaApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "AreaApiError";
    this.status = status;
  }
}

export interface AreaApiClientOptions {
  /** Fresh base URL on every call (settings can change mid-session). */
  baseUrl(): string;
  /** Fresh session token on every call (secret storage). */
  token(): Promise<string | null>;
  /** Called on any 401 so the UI can flip to "disconnected". */
  onUnauthorized?(): void;
}

type ParsedEnvelope<T> = {
  ok?: boolean;
  error?: string;
} & T;

const SESSION_COOKIE = "area_session";

export class AreaApiClient {
  constructor(private readonly opts: AreaApiClientOptions) {}

  // ---------------------------------------------------------------- helpers

  private url(path: string): string {
    const base = this.opts.baseUrl().trim().replace(/\/+$/, "");
    return `${base}${path}`;
  }

  private async authHeaders(json: boolean): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};
    if (json) headers["Content-Type"] = "application/json";
    const token = await this.opts.token();
    if (token) headers["Cookie"] = `${SESSION_COOKIE}=${token}`;
    return headers;
  }

  private async parseBody(res: Response): Promise<Record<string, unknown> | null> {
    try {
      const text = await res.text();
      return text ? (JSON.parse(text) as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  /** Shared JSON request path with honest error propagation. */
  private async request<T>(
    path: string,
    init: { method?: string; body?: string; auth?: boolean } = {}
  ): Promise<T> {
    const auth = init.auth !== false;
    let res: Response;
    try {
      res = await fetch(this.url(path), {
        method: init.method ?? "GET",
        headers: await this.authHeaders(auth),
        body: init.body,
      });
    } catch (err) {
      throw new AreaApiError(
        `Cannot reach AREA at ${this.opts.baseUrl()} (${err instanceof Error ? err.message : String(err)})`,
        0
      );
    }
    if (res.status === 401) this.opts.onUnauthorized?.();
    const json = (await this.parseBody(res)) as ParsedEnvelope<T> | null;
    if (!res.ok) {
      throw new AreaApiError(
        (json?.error as string) ?? `Request failed (HTTP ${res.status})`,
        res.status
      );
    }
    if (json && json.ok === false) {
      throw new AreaApiError((json.error as string) ?? "Request failed", res.status);
    }
    return json as T;
  }

  // ------------------------------------------------------------------- auth

  /**
   * POST /api/auth/login — verify email/password and extract the signed
   * session token from the Set-Cookie response header. Returns the token for
   * the caller to persist in secret storage, plus the user record.
   */
  async login(email: string, password: string): Promise<{ token: string; user: AreaUser }> {
    let res: Response;
    try {
      res = await fetch(this.url("/api/auth/login"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
    } catch (err) {
      throw new AreaApiError(
        `Cannot reach AREA at ${this.opts.baseUrl()} (${err instanceof Error ? err.message : String(err)})`,
        0
      );
    }

    const json = (await this.parseBody(res)) as { ok?: boolean; error?: string; user?: AreaUser } | null;
    if (res.status === 401) this.opts.onUnauthorized?.();
    if (!res.ok || !json || json.ok === false || !json.user) {
      throw new AreaApiError(
        json?.error ?? `Sign-in failed (HTTP ${res.status})`,
        res.status
      );
    }

    // Collect every Set-Cookie (getSetCookie on modern Node; single joined
    // header as fallback) and pull the area_session value out of it.
    const rawCookies: string[] =
      typeof (res.headers as { getSetCookie?: () => string[] }).getSetCookie === "function"
        ? (res.headers as { getSetCookie: () => string[] }).getSetCookie()
        : [res.headers.get("set-cookie") ?? ""];
    let token: string | null = null;
    for (const raw of rawCookies) {
      const match = /(?:^|[,\s;])area_session=([A-Za-z0-9_.\-]+)/.exec(raw);
      if (match) {
        token = match[1];
        break;
      }
    }
    if (!token) {
      throw new AreaApiError(
        "The server accepted the login but did not return a session token",
        res.status
      );
    }
    return { token, user: json.user };
  }

  /**
   * GET /api/auth/me — connection probe. Returns the user when a valid
   * session exists, null when not signed in.
   */
  async me(): Promise<AreaUser | null> {
    const json = await this.request<{ user: AreaUser | null }>("/api/auth/me");
    return json.user ?? null;
  }

  // --------------------------------------------------------------- projects

  /** GET /api/projects — list the user's projects with activity counters. */
  async listProjects(): Promise<AreaProject[]> {
    const json = await this.request<{ projects: AreaProject[] }>("/api/projects");
    return json.projects ?? [];
  }

  // ---------------------------------------------------------------- targets

  /** GET /api/targets — all uploaded targets with their latest run. */
  async listTargets(): Promise<AreaTarget[]> {
    const json = await this.request<{ targets: AreaTarget[] }>("/api/targets");
    return json.targets ?? [];
  }

  /**
   * POST /api/targets — upload a file as a new analysis target
   * (multipart field `file`).
   */
  async uploadTarget(fileName: string, bytes: Uint8Array): Promise<AreaUploadResult> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(bytes)]), fileName);
    // Drop the JSON content type — fetch computes the multipart boundary.
    const headers = await this.authHeaders(false);
    let res: Response;
    try {
      res = await fetch(this.url("/api/targets"), { method: "POST", headers, body: form });
    } catch (err) {
      throw new AreaApiError(
        `Cannot reach AREA at ${this.opts.baseUrl()} (${err instanceof Error ? err.message : String(err)})`,
        0
      );
    }
    if (res.status === 401) this.opts.onUnauthorized?.();
    const json = (await this.parseBody(res)) as
      | { ok?: boolean; error?: string; target?: AreaUploadResult }
      | null;
    if (!res.ok || !json || json.ok === false || !json.target) {
      throw new AreaApiError(
        json?.error ?? `Upload failed (HTTP ${res.status})`,
        res.status
      );
    }
    return json.target;
  }

  /**
   * POST /api/targets/:id/analyze — queue an engine analysis run
   * (concurrency-safe: returns the active run id if one exists).
   */
  async analyzeTarget(targetId: string, goal?: string): Promise<string> {
    const json = await this.request<{ runId: string }>(`/api/targets/${encodeURIComponent(targetId)}/analyze`, {
      method: "POST",
      body: JSON.stringify(goal ? { goal } : {}),
    });
    return json.runId;
  }

  // ------------------------------------------------------------------ chats

  /** GET /api/chat — list chat sessions (sidebar summaries). */
  async listSessions(): Promise<AreaSession[]> {
    const json = await this.request<{ sessions: AreaSession[] }>("/api/chat");
    return json.sessions ?? [];
  }

  /** GET /api/chat?sessionId= — full message history for one session. */
  async getSession(sessionId: string): Promise<AreaSessionDetail> {
    const json = await this.request<AreaSessionDetail>(
      `/api/chat?sessionId=${encodeURIComponent(sessionId)}`
    );
    return json;
  }

  /**
   * POST /api/chat — start or continue an agent turn and stream the
   * Server-Sent-Event frames back as parsed `ChatStreamEvent`s. The
   * generator finishes on the `done` event or when the socket closes.
   */
  async *streamChat(
    body: StreamChatBody,
    signal?: AbortSignal
  ): AsyncGenerator<ChatStreamEvent, void, undefined> {
    let res: Response;
    try {
      res = await fetch(this.url("/api/chat"), {
        method: "POST",
        headers: {
          ...(await this.authHeaders(true)),
          Accept: "text/event-stream",
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (signal?.aborted) return;
      throw new AreaApiError(
        `Cannot reach AREA at ${this.opts.baseUrl()} (${err instanceof Error ? err.message : String(err)})`,
        0
      );
    }

    if (res.status === 401) this.opts.onUnauthorized?.();
    if (!res.ok || !res.body) {
      const json = (await this.parseBody(res)) as { error?: string } | null;
      throw new AreaApiError(json?.error ?? `Chat request failed (HTTP ${res.status})`, res.status);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line (\n\n or \r\n\r\n).
        for (;;) {
          const m = /\r?\n\r?\n/.exec(buffer);
          if (!m) break;
          const frame = buffer.slice(0, m.index);
          buffer = buffer.slice(m.index + m[0].length);

          const data = dataPayload(frame);
          if (!data) continue; // comment/keepalive frame
          let event: ChatStreamEvent;
          try {
            event = JSON.parse(data) as ChatStreamEvent;
          } catch {
            continue; // tolerate malformed frames instead of dying mid-stream
          }
          yield event;
          if (event.type === "done") return;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

/**
 * Extract the SSE `data:` payload of one frame. Comment lines (starting
 * with `:`) are skipped per spec; multiple data lines are joined with \n.
 */
function dataPayload(frame: string): string | null {
  const lines = frame.split(/\r?\n/);
  const data: string[] = [];
  for (const line of lines) {
    if (line.startsWith(":")) continue; // keepalive / comment
    if (line.startsWith("data:")) {
      data.push(line.slice(5).replace(/^ /, ""));
    }
  }
  return data.length > 0 ? data.join("\n") : null;
}

/** Tool-call trace rows persisted on assistant messages (`toolCalls` JSON). */
export function parseToolCalls(raw: string | null): {
  tool: string;
  args?: Record<string, unknown>;
  result?: string;
}[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as {
      tool: string;
      args?: Record<string, unknown>;
      result?: string;
    }[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export type { AreaMessage };
