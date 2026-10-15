import * as vscode from "vscode";
import path from "path";
import { MAX_UPLOAD_BYTES, AreaApiClient } from "./api";
import { openChatPanel } from "./chatPanel";
import { AREA_PARTICIPANT_ID, registerReaChatParticipant } from "./chat";
import { AreaStatusBar } from "./status";
import { AREA_PROJECT_TARGETS_KEY, AreaTreeDataProvider } from "./tree";
import type { AreaProject, AreaTarget } from "./types";

/** Secret storage key for the platform session token (area_session cookie). */
const SECRET_KEY = "area.sessionToken";
/** Workspace-state key for the last active project (drives @area context). */
const ACTIVE_PROJECT_KEY = "area.activeProjectId";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("AREA");
  context.subscriptions.push(output);

  const baseUrl = () =>
    vscode.workspace.getConfiguration("area").get<string>("baseUrl", "http://localhost:3000");

  // ------------------------------------------------------------- runtime state
  let connected = false;
  let userEmail: string | null = null;
  let activeProjectId: string | null =
    context.workspaceState.get<string>(ACTIVE_PROJECT_KEY) ?? null;
  let activeTarget: AreaTarget | null = null;
  let activeSessionId: string | null = null;

  const api = new AreaApiClient({
    baseUrl,
    token: async () => (await context.secrets.get(SECRET_KEY)) ?? null,
    onUnauthorized: () => setConnected(false, null),
  });

  const statusBar = new AreaStatusBar();
  const tree = new AreaTreeDataProvider({
    api,
    workspaceState: context.workspaceState,
    isConnected: () => connected,
    isActiveProject: (id) => id === activeProjectId,
  });
  context.subscriptions.push(statusBar, vscode.window.registerTreeDataProvider("area.explorer", tree));

  function setConnected(value: boolean, email: string | null): void {
    connected = value;
    userEmail = email;
    statusBar.set(value ? "connected" : "offline", email, baseUrl());
    void vscode.commands.executeCommand("setContext", "area.connected", value);
    tree.refresh();
  }

  function activeProject(): AreaProject | null {
    return tree.projects.find((p) => p.id === activeProjectId) ?? null;
  }

  function connectionContext() {
    return {
      project: activeProject(),
      target: activeTarget,
      session: activeSession(),
    };
  }

  function activeSession() {
    if (!activeSessionId) return null;
    return tree.sessions.find((s) => s.id === activeSessionId) ?? null;
  }

  // ---------------------------------------------------------------- connection

  async function reconnect(interactive: boolean): Promise<void> {
    const token = await context.secrets.get(SECRET_KEY);
    statusBar.set("connecting", userEmail, baseUrl());
    if (!token) {
      setConnected(false, null);
      if (interactive) await loginFlow();
      return;
    }
    try {
      const user = await api.me();
      if (user) {
        setConnected(true, user.email);
      } else {
        setConnected(false, null);
        if (interactive) await loginFlow();
      }
    } catch (err) {
      setConnected(false, userEmail);
      if (interactive) {
        vscode.window.showErrorMessage(`AREA connection failed: ${errorMessage(err)}`);
      }
      output.appendLine(`[reconnect] ${errorMessage(err)}`);
    }
  }

  async function loginFlow(): Promise<void> {
    const email = await vscode.window.showInputBox({
      prompt: "AREA account email",
      placeHolder: "you@example.com",
      ignoreFocusOut: true,
      validateInput: (v) => (v.includes("@") ? null : "Enter a valid email"),
    });
    if (!email) {
      statusBar.set(connected ? "connected" : "offline", userEmail, baseUrl());
      return;
    }
    const password = await vscode.window.showInputBox({
      prompt: `AREA password for ${email}`,
      password: true,
      ignoreFocusOut: true,
    });
    if (password === undefined) {
      statusBar.set(connected ? "connected" : "offline", userEmail, baseUrl());
      return;
    }
    statusBar.set("connecting", userEmail, baseUrl());
    try {
      const { token, user } = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Signing in to AREA…" },
        () => api.login(email.trim(), password)
      );
      await context.secrets.store(SECRET_KEY, token);
      setConnected(true, user.email);
      vscode.window.showInformationMessage(`Connected to AREA as ${user.email}`);
    } catch (err) {
      setConnected(false, null);
      vscode.window.showErrorMessage(`AREA sign-in failed: ${errorMessage(err)}`);
    }
  }

  async function logout(): Promise<void> {
    await context.secrets.delete(SECRET_KEY);
    activeSessionId = null;
    activeTarget = null;
    setConnected(false, null);
    vscode.window.showInformationMessage("Signed out of AREA.");
  }

  // -------------------------------------------------------------- file upload

  async function analyzeCurrentFile(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage("Open a file in the editor first.");
      return;
    }
    if (editor.document.uri.scheme !== "file") {
      vscode.window.showWarningMessage("Only local files can be uploaded as AREA targets.");
      return;
    }
    const uri = editor.document.uri;
    const fileName = path.basename(uri.fsPath);
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > MAX_UPLOAD_BYTES) {
        vscode.window.showErrorMessage(
          `${fileName} exceeds the ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB AREA upload cap.`
        );
        return;
      }
    } catch {
      /* stat failures will surface on the read below */
    }

    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch (err) {
      vscode.window.showErrorMessage(`Could not read ${fileName}: ${errorMessage(err)}`);
      return;
    }

    let target: AreaTarget;
    try {
      const uploaded = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Uploading ${fileName} to AREA…` },
        () => api.uploadTarget(fileName, bytes)
      );
      target = {
        id: uploaded.id,
        originalName: uploaded.originalName,
        sizeBytes: uploaded.sizeBytes,
        detectedFormat: uploaded.detectedFormat,
        formatFamily: uploaded.formatFamily,
        status: uploaded.status,
        summary: null,
        createdAt: uploaded.createdAt,
        lastRun: null,
      };
    } catch (err) {
      vscode.window.showErrorMessage(`AREA upload failed: ${errorMessage(err)}`);
      return;
    }

    // Associate the target with the active project (extension-side mapping —
    // the platform API has no project↔target link except file projects).
    if (activeProjectId) {
      await associateProjectTarget(activeProjectId, target.id);
    }
    activeTarget = target;
    tree.refresh();

    // Start an investigation chat on the fresh target.
    openChatPanel(chatPanelDeps(), {
      sessionId: null,
      title: target.originalName,
      targetId: target.id,
      autoSend:
        `Analyze the file "${target.originalName}" (detected format: ${target.detectedFormat ?? "unknown"}). ` +
        "Give me an overview: what it is, its structure, and anything notable.",
    });

    vscode.window
      .showInformationMessage(
        `Uploaded ${fileName} to AREA — chat started (format: ${target.detectedFormat ?? "unknown"}).`,
        "Run full analysis"
      )
      .then((pick) => {
        if (pick === "Run full analysis") void runAnalysis(target.id, target.originalName);
      });
  }

  async function runAnalysis(targetId: string, name: string): Promise<void> {
    try {
      const runId = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Starting AREA analysis of ${name}…` },
        () => api.analyzeTarget(targetId)
      );
      vscode.window.showInformationMessage(`AREA analysis started (run ${runId}).`);
      tree.refresh();
    } catch (err) {
      vscode.window.showErrorMessage(`Could not start analysis: ${errorMessage(err)}`);
    }
  }

  async function associateProjectTarget(projectId: string, targetId: string): Promise<void> {
    const map = context.workspaceState.get<Record<string, string[]>>(AREA_PROJECT_TARGETS_KEY, {});
    const list = new Set(map[projectId] ?? []);
    list.add(targetId);
    map[projectId] = Array.from(list);
    await context.workspaceState.update(AREA_PROJECT_TARGETS_KEY, map);
  }

  // -------------------------------------------------------------- chat panels

  function chatPanelDeps() {
    return {
      api,
      isConnected: () => connected,
      onSessionMutated: () => tree.refresh(),
    };
  }

  // ----------------------------------------------------------------- commands

  context.subscriptions.push(
    vscode.commands.registerCommand("area.login", () => void loginFlow()),
    vscode.commands.registerCommand("area.logout", () => void logout()),
    vscode.commands.registerCommand("area.reconnect", () => void reconnect(true)),
    vscode.commands.registerCommand("area.refresh", () => tree.refresh()),
    vscode.commands.registerCommand("area.newChat", () => {
      activeSessionId = null;
      vscode.window.showInformationMessage("Next @area message starts a new chat.");
    }),
    vscode.commands.registerCommand("area.analyzeCurrentFile", () => void analyzeCurrentFile()),
    vscode.commands.registerCommand(
      "area.openChat",
      (node: { kind: string; session?: { id: string; title: string } }) => {
        if (node?.kind === "chat" && node.session) {
          activeSessionId = node.session.id;
          openChatPanel(chatPanelDeps(), {
            sessionId: node.session.id,
            title: node.session.title || "Chat",
          });
        }
      }
    ),
    vscode.commands.registerCommand(
      "area.analyzeTarget",
      (node: { kind: string; target?: AreaTarget }) => {
        if (node?.kind === "target" && node.target) {
          activeTarget = node.target;
          void runAnalysis(node.target.id, node.target.originalName);
        }
      }
    ),
    vscode.commands.registerCommand(
      "area.setActiveProject",
      (node: { kind: string; project?: AreaProject }) => {
        if (node?.kind === "project" && node.project) {
          activeProjectId = node.project.id;
          void context.workspaceState.update(ACTIVE_PROJECT_KEY, activeProjectId);
          tree.refresh();
          vscode.window.showInformationMessage(
            `Active AREA project: ${node.project.name} — @area will use it as context.`
          );
        }
      }
    )
  );

  // -------------------------------------------------------- chat participant

  // vscode.chat exists only when GitHub Copilot Chat is installed — degrade
  // honestly instead of crashing activation.
  const chatApi = (vscode as unknown as { chat?: { createChatParticipant?: unknown } }).chat;
  if (chatApi && typeof chatApi.createChatParticipant === "function") {
    context.subscriptions.push(
      registerReaChatParticipant({
        api,
        extensionUri: context.extensionUri,
        getContext: connectionContext,
        isConnected: () => connected,
        onSessionSaved: (session) => {
          activeSessionId = session?.id ?? null;
        },
      })
    );
  } else {
    output.appendLine(
      `GitHub Copilot Chat not detected — the ${AREA_PARTICIPANT_ID} participant is unavailable. All other features work.`
    );
  }

  // ------------------------------------------------------------ config wiring

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("area.baseUrl")) {
        // The session cookie is host-scoped — revalidate against the new URL.
        void reconnect(false);
      }
    })
  );

  // --------------------------------------------------------------- activation

  void reconnect(false);
}

export function deactivate(): void {
  /* nothing to tear down — API clients are stateless, streams are per-request */
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
