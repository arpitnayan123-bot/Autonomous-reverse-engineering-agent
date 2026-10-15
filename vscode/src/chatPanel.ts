import * as vscode from "vscode";
import { parseToolCalls } from "./api";
import type { AreaApiClient } from "./api";
import type { AreaMessage } from "./types";

export interface ChatPanelDeps {
  api: AreaApiClient;
  /** Called after a turn completes so the tree can refresh counters. */
  onSessionMutated(): void;
  isConnected(): boolean;
}

export interface ChatPanelSpec {
  /** Existing session id, or null to start a new chat on the platform. */
  sessionId: string | null;
  title: string;
  /** Bind a NEW chat to this target (used by "Analyze Current File"). */
  targetId?: string | null;
  /** Optional first message to send right after the panel opens. */
  autoSend?: string;
}

const panels = new Map<string, ChatPanel>();

/**
 * Open (or reveal) a streaming chat panel for a AREA session. The panel talks
 * to the platform through the shared API client: history comes from
 * `GET /api/chat?sessionId=`, new turns stream over the SSE chat endpoint.
 */
export function openChatPanel(deps: ChatPanelDeps, spec: ChatPanelSpec): ChatPanel {
  if (spec.sessionId) {
    const existing = panels.get(spec.sessionId);
    if (existing) {
      existing.reveal();
      if (spec.autoSend) existing.send(spec.autoSend);
      return existing;
    }
  }
  const panel = new ChatPanel(deps, spec);
  if (spec.sessionId) panels.set(spec.sessionId, panel);
  void panel.init();
  if (spec.autoSend) panel.send(spec.autoSend);
  return panel;
}

export class ChatPanel implements vscode.Disposable {
  private readonly panel: vscode.WebviewPanel;
  private sessionId: string | null;
  private busy = false;
  private abort: AbortController | null = null;
  private disposed = false;

  constructor(
    private readonly deps: ChatPanelDeps,
    private readonly spec: ChatPanelSpec
  ) {
    this.sessionId = spec.sessionId;
    this.panel = vscode.window.createWebviewPanel(
      "area.chat",
      `AREA: ${spec.title}`,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [],
      }
    );
    this.panel.webview.html = this.html(this.panel.webview);

    this.panel.webview.onDidReceiveMessage((msg: { type: string; text?: string }) => {
      if (msg?.type === "send" && typeof msg.text === "string") {
        this.send(msg.text);
      }
    });
    this.panel.onDidDispose(() => {
      this.disposed = true;
      this.abort?.abort();
      if (this.sessionId) panels.delete(this.sessionId);
    });
  }

  reveal(): void {
    this.panel.reveal();
  }

  async init(): Promise<void> {
    if (!this.sessionId) {
      this.panel.webview.postMessage({ type: "init", messages: [], title: this.spec.title });
      return;
    }
    try {
      const detail = await this.deps.api.getSession(this.sessionId);
      this.panel.title = `AREA: ${detail.session.title || this.spec.title}`;
      this.panel.webview.postMessage({
        type: "init",
        title: detail.session.title,
        targetName: detail.session.targetName,
        hasMore: detail.hasMore,
        messages: detail.messages,
      });
    } catch (err) {
      this.panel.webview.postMessage({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Run one agent turn, streaming platform SSE events into the webview. */
  send(text: string): void {
    const trimmed = text.trim();
    if (!trimmed || this.busy || this.disposed) return;
    if (!this.deps.isConnected()) {
      this.panel.webview.postMessage({
        type: "error",
        message: "Not connected to AREA — run “AREA: Sign In” first.",
      });
      return;
    }

    this.busy = true;
    this.abort = new AbortController();
    const targetId = this.sessionId ? undefined : (this.spec.targetId ?? undefined);
    const post = (m: Record<string, unknown>) => {
      if (!this.disposed) void this.panel.webview.postMessage(m);
    };

    post({ type: "user", text: trimmed });
    post({ type: "turn-start" });

    void (async () => {
      let sawError: string | null = null;
      try {
        for await (const ev of this.deps.api.streamChat(
          {
            sessionId: this.sessionId ?? undefined,
            targetId,
            message: trimmed,
          },
          this.abort?.signal
        )) {
          switch (ev.type) {
            case "session_saved":
              if (!this.sessionId) {
                this.sessionId = ev.sessionId;
                panels.set(ev.sessionId, this);
              }
              post({ type: "session", sessionId: ev.sessionId });
              break;
            case "delta":
              post({ type: "delta", text: ev.text });
              break;
            case "tool_call":
              post({ type: "tool-start", label: `Tool ${ev.tool}` });
              break;
            case "tool_result":
              post({ type: "tool-end", label: `${ev.tool} done — ${shorten(ev.preview, 160)}` });
              break;
            case "subagent_start":
              post({ type: "tool-start", label: `Delegating: ${shorten(ev.task, 120)}` });
              break;
            case "subagent_end":
              post({
                type: "tool-end",
                label: `Subagent ${ev.status} — ${shorten(ev.summary ?? "", 140)}`,
              });
              break;
            case "error":
              sawError = ev.error;
              post({ type: "error", message: ev.error });
              break;
            case "assistant":
              post({ type: "assistant-final", content: ev.content });
              break;
            case "usage":
              post({
                type: "usage",
                label: [
                  ev.tokensIn != null || ev.tokensOut != null
                    ? `${ev.tokensIn ?? "?"}→${ev.tokensOut ?? "?"} tokens`
                    : null,
                  ev.durationMs != null ? `${(ev.durationMs / 1000).toFixed(1)}s` : null,
                  ev.modelId ?? null,
                  ev.compactionCount > 0 ? `compacted ×${ev.compactionCount}` : null,
                ]
                  .filter(Boolean)
                  .join(" · "),
              });
              break;
            default:
              break;
          }
        }
      } catch (err) {
        if (!this.abort?.signal.aborted) {
          sawError = err instanceof Error ? err.message : String(err);
          post({ type: "error", message: sawError });
        }
      } finally {
        this.busy = false;
        this.abort = null;
        post({ type: "done", error: sawError });
        this.deps.onSessionMutated();
      }
    })();
  }

  dispose(): void {
    this.panel.dispose();
  }

  // ------------------------------------------------------------------ html

  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data: ${webview.cspSource};`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AREA Chat</title>
  <style>
    :root { color-scheme: var(--vscode-theme-kind); }
    * { box-sizing: border-box; }
    body {
      margin: 0; display: flex; flex-direction: column; height: 100vh;
      font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
      color: var(--vscode-editor-foreground); background: var(--vscode-editor-background);
    }
    #log { flex: 1; overflow-y: auto; padding: 12px 14px; }
    .msg { margin: 0 0 14px 0; }
    .role {
      font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--vscode-descriptionForeground); margin-bottom: 3px;
    }
    .bubble {
      white-space: pre-wrap; word-wrap: break-word; line-height: 1.5;
      padding: 8px 10px; border-radius: 6px;
      background: var(--vscode-editorWidget-background, rgba(128,128,128,0.08));
    }
    .user .bubble { background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); }
    .tools { margin-top: 6px; display: flex; flex-direction: column; gap: 2px; }
    .tool {
      font-family: var(--vscode-editor-font-family); font-size: 11px;
      color: var(--vscode-descriptionForeground);
      padding: 2px 6px; border-left: 2px solid var(--vscode-charts-purple, #888);
    }
    .status { font-size: 11px; color: var(--vscode-descriptionForeground); font-style: italic; padding: 2px 0; min-height: 16px; }
    .usage { font-size: 11px; color: var(--vscode-descriptionForeground); opacity: 0.8; margin-top: 4px; }
    .error { color: var(--vscode-errorForeground); }
    form {
      display: flex; gap: 8px; padding: 10px 12px;
      border-top: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.25));
      background: var(--vscode-editorWidget-background, rgba(128,128,128,0.06));
    }
    textarea {
      flex: 1; resize: none; min-height: 44px; max-height: 140px;
      font-family: inherit; font-size: inherit; color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; padding: 8px;
    }
    textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
    button {
      align-self: flex-end; min-width: 72px; min-height: 32px; cursor: pointer;
      color: var(--vscode-button-foreground); background: var(--vscode-button-background);
      border: none; border-radius: 4px; padding: 6px 12px;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button:disabled { opacity: 0.5; cursor: default; }
    .hint { font-size: 11px; color: var(--vscode-descriptionForeground); padding: 0 12px 8px; }
  </style>
</head>
<body>
  <div id="log" aria-live="polite"></div>
  <form id="composer">
    <textarea id="input" placeholder="Ask AREA… (Enter to send, Shift+Enter for a new line)"></textarea>
    <button id="send" type="submit">Send</button>
  </form>
  <div class="hint" id="hint"></div>
  <script nonce="${nonce}">
    (function () {
      var vscode = acquireVsCodeApi();
      var log = document.getElementById("log");
      var input = document.getElementById("input");
      var sendBtn = document.getElementById("send");
      var hint = document.getElementById("hint");
      var pendingAssistant = null;

      function esc(s) {
        return String(s)
          .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;");
      }
      function nearBottom() {
        return log.scrollHeight - log.scrollTop - log.clientHeight < 60;
      }
      function scrollDown(force) {
        if (force || nearBottom()) log.scrollTop = log.scrollHeight;
      }
      function addMessage(role, text) {
        var wrap = document.createElement("div");
        wrap.className = "msg " + role;
        var r = document.createElement("div");
        r.className = "role";
        r.textContent = role === "user" ? "You" : "AREA";
        var b = document.createElement("div");
        b.className = "bubble";
        b.textContent = text || "";
        wrap.appendChild(r); wrap.appendChild(b);
        log.appendChild(wrap);
        scrollDown(true);
        return b;
      }
      function addToolLine(parent, label) {
        var t = document.createElement("div");
        t.className = "tool";
        t.textContent = label;
        parent.parentNode.insertBefore(t, parent.nextSibling);
        return t;
      }
      function newAssistantBlock() {
        var wrap = document.createElement("div");
        wrap.className = "msg assistant";
        var r = document.createElement("div");
        r.className = "role"; r.textContent = "AREA";
        var b = document.createElement("div");
        b.className = "bubble";
        var status = document.createElement("div");
        status.className = "status";
        status.textContent = "Thinking…";
        wrap.appendChild(r); wrap.appendChild(b); wrap.appendChild(status);
        log.appendChild(wrap);
        scrollDown(true);
        pendingAssistant = { bubble: b, status: status, wrap: wrap };
        return pendingAssistant;
      }
      function setBusy(busy) {
        sendBtn.disabled = busy;
        input.disabled = busy;
        if (!busy) input.focus();
      }
      function endTurn(err) {
        if (pendingAssistant) {
          if (!pendingAssistant.bubble.textContent) {
            pendingAssistant.bubble.textContent = err ? "(no response)" : "(turn cancelled or empty)";
          }
          pendingAssistant.status.textContent = err ? "⚠ " + err : "";
          pendingAssistant = null;
        }
        setBusy(false);
      }

      document.getElementById("composer").addEventListener("submit", function (e) {
        e.preventDefault();
        var text = input.value.trim();
        if (!text) return;
        input.value = "";
        addMessage("user", text);
        vscode.postMessage({ type: "send", text: text });
      });

      window.addEventListener("message", function (e) {
        var m = e.data;
        switch (m.type) {
          case "init": {
            hint.textContent = m.hasMore
              ? "Showing the most recent messages — older history stays in the AREA web app."
              : (m.targetName ? "Target: " + m.targetName : "");
            (m.messages || []).forEach(function (msg) {
              var b = addMessage(msg.role === "assistant" ? "assistant" : "user", msg.content);
              var tools = parseTools(msg.toolCalls);
              if (tools.length > 0) {
                var holder = document.createElement("div");
                holder.className = "tools";
                tools.forEach(function (t) {
                  var line = document.createElement("div");
                  line.className = "tool";
                  line.textContent = "⚙ " + t.tool + (t.result ? " — " + truncate(String(t.result), 140) : "");
                  holder.appendChild(line);
                });
                b.parentNode.insertBefore(holder, b.nextSibling);
              }
            });
            if ((m.messages || []).length === 0) {
              addMessage("assistant", "This chat has no messages yet. Send the first question below.");
            }
            scrollDown(true);
            break;
          }
          case "user":
            // already rendered optimistically by the sender
            break;
          case "turn-start":
            newAssistantBlock();
            setBusy(true);
            break;
          case "session":
            vscode.setState({ sessionId: m.sessionId });
            break;
          case "delta":
            if (pendingAssistant) {
              pendingAssistant.status.textContent = "";
              pendingAssistant.bubble.textContent += m.text || "";
              scrollDown(false);
            }
            break;
          case "tool-start":
            if (pendingAssistant) pendingAssistant.status.textContent = "⚙ " + m.label;
            break;
          case "tool-end":
            if (pendingAssistant) {
              addToolLine(pendingAssistant.bubble, "✔ " + m.label);
              pendingAssistant.status.textContent = "";
            }
            break;
          case "assistant-final":
            if (pendingAssistant) pendingAssistant.bubble.textContent = m.content || "";
            break;
          case "usage":
            if (pendingAssistant) {
              var u = document.createElement("div");
              u.className = "usage";
              u.textContent = m.label || "";
              pendingAssistant.bubble.parentNode.insertBefore(u, pendingAssistant.bubble.nextSibling);
            }
            break;
          case "error":
            if (pendingAssistant) {
              pendingAssistant.status.textContent = "⚠ " + m.message;
              pendingAssistant.status.className = "status error";
            } else {
              addMessage("assistant", "⚠ " + m.message);
            }
            scrollDown(true);
            break;
          case "done":
            endTurn(m.error);
            break;
        }
      });

      function parseTools(raw) {
        if (!raw) return [];
        try {
          var parsed = JSON.parse(raw);
          return Array.isArray(parsed) ? parsed : [];
        } catch (e) { return []; }
      }
      function truncate(s, n) {
        s = s.replace(/\\s+/g, " ").trim();
        return s.length > n ? s.slice(0, n) + "…" : s;
      }
    })();
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

function shorten(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

export { parseToolCalls };
