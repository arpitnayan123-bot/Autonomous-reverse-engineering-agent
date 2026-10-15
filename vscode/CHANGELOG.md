# Change Log

All notable changes to the REA Platform extension are documented in this file.

## 0.1.0

- Initial release.
- Sign in with email/password against a self-hosted REA instance (`rea.baseUrl`);
  the session token is stored in VS Code secret storage.
- REA Explorer tree: projects (collapsible), targets per project (click to analyze),
  chats per project (click to open in a streaming chat panel).
- `@rea` chat participant for Copilot Chat — forwards questions to the platform
  `/api/chat` endpoint, streams answers token-by-token and renders tool calls
  as progress messages.
- Command `REA: Analyze Current File` — uploads the active editor file as a
  target and starts an investigation chat.
- Status bar item showing connection state with click-to-reconnect.
