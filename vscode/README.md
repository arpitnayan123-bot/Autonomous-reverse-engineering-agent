# AREA Platform — VS Code extension

Connect Visual Studio Code to a **self-hosted AREA instance**: browse projects,
targets and investigation chats, analyze the file you are editing, and ask
`@area` directly from Copilot Chat.

The extension is plain TypeScript compiled with `tsc` — no webpack/bundler —
so the build is a single `tsc -p ./` step (standard `yo code` layout).

## Features

| Area | What it does |
| --- | --- |
| **Sign in** | Email/password prompt against your instance; the signed session token (`area_session` cookie value) is stored in **VS Code secret storage** — never in settings or files. |
| **AREA Explorer** (Activity Bar) | Projects (collapsible) → per project: **Targets** (click to start an analysis run) and **Chats** (click to open a streaming chat panel). |
| **`@area` chat participant** | In Copilot Chat, type `@area <question>`. The question is forwarded to the platform `POST /api/chat` with the **active project** as context; answers stream **token-by-token** and platform tool calls are rendered as **progress messages**. |
| **AREA: Analyze Current File** | Uploads the active editor file as a new target (`POST /api/targets`), starts a chat bound to it, and offers to queue a full engine analysis (`POST /api/targets/:id/analyze`). |
| **Status bar** | Connection state (connected / disconnected / connecting). Clicking it reconnects — revalidating the stored session or prompting for login. |

### Chat binding rules

- Right-click a project → **Set as Active Project** — `@area` then prefixes
  questions with that project's context.
- Clicking a chat in the tree makes it the **active chat**; the next `@area`
  message continues that thread. `AREA: New Chat` clears the binding.
- The platform associates chats with targets (uploaded files). For **file
  projects** the target comes from the project reference; targets you upload
  with `AREA: Analyze Current File` while a project is active are associated
  with it via extension workspace state.

## Setup

1. `npm install` (or `bun install`) inside `vscode/`.
2. `npm run compile` — emits `out/extension.js`.
3. Point the extension at your instance: Settings → **AREA: Base Url**
   (`area.baseUrl`, default `http://localhost:3000`). Any self-hosted URL works,
   including `https://area.example.com`.
4. Launch: **F5** (Extension Development Host) or install the packaged `.vsix`
   (below).
5. Click the AREA status bar item (or run `AREA: Sign In`) and sign in with your
   platform account.

> The `@area` participant requires **GitHub Copilot Chat** to be installed.
> Everything else (tree, chat panels, uploads, status bar) works without it.

## Permissions & security notes

- The session token lives in VS Code's secret storage (OS keychain backed) and
  is only sent to the configured `area.baseUrl`.
- Changing `area.baseUrl` triggers an automatic session re-validation — the
  cookie is host-scoped.
- Uploads respect the platform cap (50 MB) and are rejected client-side first.

## Package as `.vsix`

```bash
cd vscode
npm install
npm run compile
npm run package        # → area-vscode-0.1.0.vsix
```

`npm run package` runs `vsce package --allow-missing-repository` (this repo has
no git remote configured). The `vscode:prepublish` hook compiles TypeScript
first, so `npm run package` alone is enough.

Install into any VS Code:

```bash
code --install-extension area-vscode-0.1.0.vsix
```

or via the UI: Extensions view → `…` menu → **Install from VSIX…**.

### Before distributing

- Change `publisher` in `vscode/package.json` (currently `arpit-nayan`) to
  your marketplace publisher id.
- Bump `version` in `package.json` and add a `CHANGELOG.md` entry.
- Re-run `npm run package`.

## Publish to the Marketplace

1. Create a publisher at <https://marketplace.visualstudio.com/manage> and a
   Personal Access Token (Azure DevOps, scope **Marketplace → Manage**).
2. ```bash
   cd vscode
   npx @vscode/vsce login <publisher-id>     # paste the PAT once
   npm run publish                            # vsce publish (packages + uploads)
   ```
3. For Open VSX (VSCodium/other editors):
   ```bash
   npx ovsx publish -p <open-vsx-pat>
   ```

## Project layout

```
vscode/
├── package.json          # extension manifest (commands, views, config)
├── tsconfig.json         # tsc — CommonJS/Node16, no bundler
├── .vscodeignore         # what stays out of the .vsix
├── media/                # activity bar + marketplace icon
├── .vscode/launch.json   # F5 debugging (Extension Development Host)
└── src/
    ├── extension.ts      # activation, commands, wiring
    ├── api.ts            # REST + SSE client (auth via session cookie)
    ├── types.ts          # wire-format mirrors of the platform API
    ├── status.ts         # status bar connection state
    ├── tree.ts           # AREA Explorer (projects/targets/chats)
    ├── chat.ts           # @area Copilot Chat participant
    └── chatPanel.ts      # streaming webview chat panel
```

## Platform API endpoints used

| Endpoint | Purpose |
| --- | --- |
| `POST /api/auth/login` | Email/password → `Set-Cookie: area_session=…` |
| `GET /api/auth/me` | Session validation / connection probe |
| `GET /api/projects` | Project list (tree root) |
| `GET /api/targets` · `POST /api/targets` | List / upload targets |
| `POST /api/targets/:id/analyze` | Start an engine analysis run |
| `GET /api/chat` · `GET /api/chat?sessionId=` | Session list / message history |
| `POST /api/chat` | Agent turn — SSE (`delta`, `tool_call`, `tool_result`, `usage`, `error`, `done`) |
