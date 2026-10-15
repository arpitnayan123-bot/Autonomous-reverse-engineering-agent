import * as vscode from "vscode";

export type ConnectionState = "offline" | "connecting" | "connected";

/**
 * Status bar item showing the AREA connection state.
 * Clicking it always runs `AREA: Reconnect` (validates or re-prompts login).
 */
export class AreaStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private state: ConnectionState = "offline";
  private email: string | null = null;
  private baseUrl: string | null = null;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.name = "AREA";
    this.item.command = { command: "area.reconnect", title: "AREA: Reconnect" };
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
        this.item.text = "$(cloud) AREA";
        this.item.backgroundColor = undefined;
        this.item.tooltip = new vscode.MarkdownString(
          `**AREA: connected**${this.email ? ` as \`${this.email}\`` : ""}\n\n` +
            `Instance: ${this.baseUrl ?? "?"}\n\n` +
            `_Click to reconnect / refresh the session._`
        );
        break;
      case "connecting":
        this.item.text = "$(sync~spin) AREA…";
        this.item.backgroundColor = undefined;
        this.item.tooltip = "AREA: checking connection…";
        break;
      default:
        this.item.text = "$(circle-slash) AREA";
        this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
        this.item.tooltip = new vscode.MarkdownString(
          "**AREA: disconnected**\n\nNo valid session for the configured instance.\n\n_Click to reconnect (you will be asked to sign in if needed)._"
        );
        break;
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}
