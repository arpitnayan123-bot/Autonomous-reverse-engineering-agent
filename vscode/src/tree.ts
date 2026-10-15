import * as vscode from "vscode";
import type { ReaApiClient } from "./api";
import type { ReaProject, ReaSession, ReaTarget } from "./types";

/**
 * Workspace-state key holding the extension-side association of uploaded
 * targets to projects. The platform API has no project↔target link for
 * website/github projects (file projects reference `targets/<id>`), so the
 * extension records "target X was uploaded while project P was active" here.
 */
export const REA_PROJECT_TARGETS_KEY = "rea.projectTargets";

export type ReaNode =
  | { kind: "project"; project: ReaProject; active: boolean }
  | { kind: "group"; label: string; projectId: string; group: "targets" | "chats"; count: number }
  | { kind: "target"; project: ReaProject; target: ReaTarget }
  | { kind: "chat"; project: ReaProject; session: ReaSession }
  | { kind: "info"; label: string; detail?: string; command?: { command: string; title: string } };

export interface ReaTreeDeps {
  api: ReaApiClient;
  workspaceState: vscode.Memento;
  isConnected(): boolean;
  isActiveProject(projectId: string): boolean;
}

export class ReaTreeDataProvider implements vscode.TreeDataProvider<ReaNode> {
  private readonly emitter = new vscode.EventEmitter<ReaNode | undefined | null | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  /** Cached data so commands (setActiveProject etc.) can look things up. */
  projects: ReaProject[] = [];
  targets: ReaTarget[] = [];
  sessions: ReaSession[] = [];

  constructor(private readonly deps: ReaTreeDeps) {}

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(node: ReaNode): vscode.TreeItem {
    switch (node.kind) {
      case "project": {
        const item = new vscode.TreeItem(node.project.name, vscode.TreeItemCollapsibleState.Expanded);
        item.description = `${node.project.kind}${node.project.reference ? ` · ${node.project.reference}` : ""}`;
        item.iconPath = new vscode.ThemeIcon(node.active ? "root-folder" : "folder-library");
        item.contextValue = "reaProject";
        item.tooltip = new vscode.MarkdownString(
          `**${node.project.name}**\n\n` +
            `Kind: ${node.project.kind}${node.project.reference ? `\n\nReference: ${node.project.reference}` : ""}\n\n` +
            (node.project.description ? `${node.project.description}\n\n` : "") +
            (node.active ? "_Active project — used as context for @rea chats._\n\n" : "") +
            `_Updated ${new Date(node.project.updatedAt).toLocaleString()}_`
        );
        return item;
      }
      case "group": {
        const item = new vscode.TreeItem(
          `${node.label} (${node.count})`,
          node.count > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None
        );
        item.iconPath = new vscode.ThemeIcon(node.group === "targets" ? "file-binary" : "comment-discussion");
        item.contextValue = "reaGroup";
        return item;
      }
      case "target": {
        const t = node.target;
        const item = new vscode.TreeItem(t.originalName, vscode.TreeItemCollapsibleState.None);
        item.description = `${t.detectedFormat ?? t.formatFamily ?? "unknown"} · ${formatBytes(t.sizeBytes)}${
          t.lastRun ? ` · ${t.lastRun.status}` : ""
        }`;
        item.iconPath = new vscode.ThemeIcon("file-binary");
        item.contextValue = "reaTarget";
        // Click to analyze: starts (or joins) an engine run on the platform.
        item.command = { command: "rea.analyzeTarget", title: "Analyze Target", arguments: [node] };
        item.tooltip = new vscode.MarkdownString(
          `**${t.originalName}**\n\n` +
            `Status: ${t.status}\n\n` +
            `Format: ${t.detectedFormat ?? "unknown"} (${t.formatFamily ?? "?"})\n\n` +
            `Size: ${formatBytes(t.sizeBytes)}\n\n` +
            (t.summary ? `${t.summary.slice(0, 400)}\n\n` : "") +
            (t.lastRun
              ? `Last run: ${t.lastRun.status}${t.lastRun.currentStep ? ` — ${t.lastRun.currentStep}` : ""} · ${t.lastRun.findingsCount} findings\n\n`
              : "") +
            `_Click to start an analysis run._`
        );
        return item;
      }
      case "chat": {
        const s = node.session;
        const item = new vscode.TreeItem(s.title || "Untitled chat", vscode.TreeItemCollapsibleState.None);
        item.description = s.targetName ? s.targetName : `${s.messageCount} messages`;
        item.iconPath = new vscode.ThemeIcon("comment-discussion");
        item.contextValue = "reaChat";
        // Click to open: streams the conversation into a chat panel.
        item.command = { command: "rea.openChat", title: "Open Chat", arguments: [node] };
        item.tooltip = new vscode.MarkdownString(
          `**${s.title || "Untitled chat"}**\n\n` +
            `${s.messageCount} messages${s.targetName ? ` · target: ${s.targetName}` : ""}${
              s.costUsd != null ? ` · est. $${s.costUsd.toFixed(4)}` : ""
            }\n\n_Updated ${new Date(s.updatedAt).toLocaleString()}_`
        );
        return item;
      }
      default: {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon(node.command ? "arrow-right" : "info");
        if (node.command) item.command = { ...node.command, title: node.label };
        if (node.detail) item.tooltip = node.detail;
        return item;
      }
    }
  }

  async getChildren(element?: ReaNode): Promise<ReaNode[]> {
    if (!element) return this.getRoots();

    if (element.kind === "project") {
      const projectTargets = this.targetsForProject(element.project);
      const chats = this.chatsForProject(element.project, projectTargets);
      return [
        { kind: "group", label: "Targets", projectId: element.project.id, group: "targets", count: projectTargets.length },
        { kind: "group", label: "Chats", projectId: element.project.id, group: "chats", count: chats.length },
      ];
    }

    if (element.kind === "group") {
      const project = this.projects.find((p) => p.id === element.projectId);
      if (!project) return [];
      const projectTargets = this.targetsForProject(project);
      if (element.group === "targets") {
        if (projectTargets.length === 0) {
          return [
            {
              kind: "info",
              label: "No targets yet — run “REA: Analyze Current File” with this project active",
            },
          ];
        }
        return projectTargets
          .map((t) => ({ kind: "target", project, target: t }) as ReaNode)
          .sort((a, b) =>
            (b as { target: ReaTarget }).target.createdAt.localeCompare((a as { target: ReaTarget }).target.createdAt)
          );
      }
      const chats = this.chatsForProject(project, projectTargets);
      if (chats.length === 0) {
        return [
          {
            kind: "info",
            label: "No target-bound chats yet — ask @rea in Copilot Chat, or open a chat on a target",
          },
        ];
      }
      return chats.map((s) => ({ kind: "chat", project, session: s }) as ReaNode);
    }

    return [];
  }

  // ------------------------------------------------------------------ roots

  private async getRoots(): Promise<ReaNode[]> {
    if (!this.deps.isConnected()) {
      return []; // viewsWelcome renders the sign-in affordance instead
    }
    try {
      const [projects, targets, sessions] = await Promise.all([
        this.deps.api.listProjects(),
        this.deps.api.listTargets(),
        this.deps.api.listSessions(),
      ]);
      this.projects = projects;
      this.targets = targets;
      this.sessions = sessions;
    } catch (err) {
      return [
        {
          kind: "info",
          label: `Could not load workspace: ${err instanceof Error ? err.message : String(err)}`,
          detail: "Check the rea.baseUrl setting and your connection, then refresh.",
        },
      ];
    }

    if (this.projects.length === 0) {
      return [
        {
          kind: "info",
          label: "No projects yet — create one in the REA web app, then refresh",
        },
      ];
    }
    return this.projects.map(
      (p) => ({ kind: "project", project: p, active: this.deps.isActiveProject(p.id) }) as ReaNode
    );
  }

  // --------------------------------------------------------- associations

  /** Target ids associated with a project (file reference + uploaded-here). */
  targetsForProject(project: ReaProject): ReaTarget[] {
    const ids = new Set<string>();
    if (project.kind === "file" && project.reference.startsWith("targets/")) {
      ids.add(project.reference.slice("targets/".length));
    }
    const map = this.deps.workspaceState.get<Record<string, string[]>>(REA_PROJECT_TARGETS_KEY, {});
    for (const id of map[project.id] ?? []) ids.add(id);
    return this.targets.filter((t) => ids.has(t.id));
  }

  /** Chats whose target belongs to the project's associated target set. */
  chatsForProject(project: ReaProject, projectTargets: ReaTarget[]): ReaSession[] {
    const ids = new Set(projectTargets.map((t) => t.id));
    return this.sessions.filter((s) => s.targetId && ids.has(s.targetId));
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
