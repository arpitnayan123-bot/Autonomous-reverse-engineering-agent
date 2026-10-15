import * as vscode from "vscode";

export type ConnectionState = "offline" | "connecting" | "connected";

/**
 * Status bar item showing the REA connection state.
 * Clicking it always runs `REA: Reconnect` (validates or re-prompts login).
 */
export class ReaStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private state: ConnectionState = "offline";
  private email: string | null = null;
  private baseUrl: string | null = null;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.name = "REA";
    this.item.command = { command: "rea.reconnect", title: "REA: Reconnect" };
    this.render();
    this.item.show();
  }

  set(state: ConnectionState, email?: string | null, baseUrl?: string | null): void {
    this.state = state;
    if (email !== undefined) this.email = email;
    if (baseUrl !== undefined) this.baseUrl = baseUrl;
    this.render();
  }

  private render(): void {
    switch (this.state) {
      case "connected":
        this.item.text = "$(cloud) REA";
        this.item.backgroundColor = undefined;
        this.item.tooltip = new vscode.MarkdownString(
          `**REA: connected**${this.email ? ` as \`${this.email}\`` : ""}\n\n` +
            `Instance: ${this.baseUrl ?? "?"}\n\n` +
            `_Click to reconnect / refresh the session._`
        );
        break;
      case "connecting":
        this.item.text = "$(sync~spin) REA…";
        this.item.backgroundColor = undefined;
        this.item.tooltip = "REA: checking connection…";
        break;
      default:
        this.item.text = "$(circle-slash) REA";
        this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
        this.item.tooltip = new vscode.MarkdownString(
          "**REA: disconnected**\n\nNo valid session for the configured instance.\n\n_Click to reconnect (you will be asked to sign in if needed)._"
        );
        break;
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}
