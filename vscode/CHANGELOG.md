# Change Log

All notable changes to the AREA Platform extension are documented in this file.

## 0.1.0

- Initial release.
- Sign in with email/password against a self-hosted AREA instance (`area.baseUrl`);
  the session token is stored in VS Code secret storage.
- AREA Explorer tree: projects (collapsible), targets per project (click to analyze),
  chats per project (click to open in a streaming chat panel).
- `@area` chat participant for Copilot Chat — forwards questions to the platform
  `/api/chat` endpoint, streams answers token-by-token and renders tool calls
  as progress messages.
- Command `AREA: Analyze Current File` — uploads the active editor file as a
  target and starts an investigation chat.
- Status bar item showing connection state with click-to-reconnect.
