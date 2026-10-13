# REA Platform — Worklog

## Project
Transform REA (https://github.com/morluto/rea) into a complete browser-based AI-powered reverse-engineering platform.

## Audit Summary (Task 1 — completed)
- REA = "Reverse Engineer Anything", npm package `rea-agents` v6.4.0 (MIT), Node ^22.19/^24.11/26+.
- Real engine installed at `/home/z/my-project/node_modules/rea-agents/scripts/rea.mjs`.
- Engine verified WORKING in sandbox via:
  - CLI: `rea capabilities`, `rea doctor`, `rea inspect-artifact`, `rea analyze-javascript-application` produce full Evidence JSON.
  - MCP: `node rea.mjs --mcp` speaks JSON-RPC 2.0 over stdio, advertises **170 tools**.
- Native providers (Hopper/Ghidra/IDA) are BYO desktop apps → unavailable here; engine fails closed with clear diagnostics (this is correct REA behavior and will be surfaced in UI).
- Host tools available: node 24.21, strings, file, objdump, python3.12. NOT available: wabt, jadx, tshark, pwntools, binwalk.

## Architecture Decision
- **Engine preservation**: the platform drives the REAL REA engine through its MCP stdio server (JSON-RPC 2.0), exactly the interface REA exposes to agents. CLI used where simpler. Own analyzers only supplement (strings/hex).
- **Single route SPA**: all UI on `/` (per sandbox constraint) with client-side views; API routes under `/api/*`.
- **Auth**: custom credential auth (scrypt hashes via node:crypto, HMAC-signed HttpOnly cookie sessions) — reliable in sandbox.
- **Security**: 50MB upload cap, magic-byte validation, UUID storage names, analysis in child processes with timeout+SIGKILL+output caps, SELECT-only SQL guard, rate limiting, audit log.
- **Evidence-first**: REA's observed/derived/inferred/unknown ledger is preserved and surfaced in UI.

## API Contract (v1)
```
POST /api/auth/register {email,password,name} → {ok,user}
POST /api/auth/login {email,password} → {ok,user}        # sets rea_session cookie
POST /api/auth/logout → {ok}
GET  /api/auth/me → {ok,user|null}
GET  /api/capabilities → {ok, engine:{version, healthy}, tools:[{name,title,kind,description}], hostTools, providers}
POST /api/targets (multipart: file) → {ok,target}
GET  /api/targets → {ok,targets}
GET  /api/targets/[id] → {ok,target with runs summary}
DELETE /api/targets/[id] → {ok}
POST /api/targets/[id]/analyze {goal?} → {ok,runId}
GET  /api/targets/[id]/evidence → {ok,evidence}
GET  /api/targets/[id]/findings?type=&q= → {ok,findings}
GET  /api/targets/[id]/hex?offset=&length= → {ok,offset,bytes,hex,ascii}
GET  /api/targets/[id]/strings?q=&page= → {ok,strings,total,page,pageSize}
GET  /api/targets/[id]/docs → {ok,docs,summary}
POST /api/targets/[id]/report {action:"generate-docs"} → {ok}
POST /api/chat {targetId,message} → SSE stream: events {type:"user_saved"|"tool_call"|"tool_result"|"assistant"|"error"|"done", ...}
GET  /api/chat?targetId= → {ok,session,messages}
GET  /api/audit → {ok,events}
GET  /api/security → {ok,posture}
```

## DB Schema (v1)
User, Target, AnalysisRun, Evidence, Finding, ChatSession, ChatMessage, AuditLog — see prisma/schema.prisma.

## Storage Layout
- Uploads: `/home/z/my-project/storage/uploads/<targetId>/original` (never user-controlled path)
- Extractions: `/home/z/my-project/storage/extract/<targetId>/`

## Tasks
- [x] Task 1: Repository audit (this file, Audit Summary above)
- [x] Task 2-foundation: schema + auth + security lib + worklog (main agent)
- [ ] Task 2-a: REA engine bridge + analysis pipeline (subagent)
- [ ] Task 2-b: AI agent + chat SSE (subagent)
- [x] Task 3-a: Frontend SPA (subagent)
- [ ] Task 4: Integration pass (main agent)
- [ ] Task 5: agent-browser E2E verification (main agent)
- [ ] Task 6: cron webDevReview job

---
Task ID: 3-a
Agent: frontend-styling-expert
Task: Frontend SPA (Next.js 16 App Router SPA on `/` with client-side view switching)

Work Log:
- Read worklog audit + API contract v1; coded every view strictly against it (envelope `{ok,...}` / `{ok:false,error}` handling with destructive toasts via existing `use-toast` hook + Toaster already mounted in layout).
- `src/lib/api-client.ts`: typed fetch layer — `apiGet`/`apiPost`/`apiDelete` (unwrap + `throw Error(error)`), `apiUpload` via XMLHttpRequest with real upload-progress %, `streamChat` POST /api/chat consuming SSE (`data: {json}\n\n` frames buffered + split, CRLF-safe, malformed frames ignored, `[DONE]` skipped). Exports all contract types: ReaUser, TargetSummary, TargetDetail, Run, RunSummary, Finding, EvidenceRow, ChatMessageRow, ChatSession, Capabilities, HexPage/HexRow, StringsPage, SecurityData, AuditEvent, ChatStreamEvent.
- `src/store/rea-store.ts`: light zustand store — `booted, user, view ('dashboard'|'workspace'|'chat'|'capabilities'|'security'|'docs'), activeTargetId, targets, capabilities` + actions (`setBooted/setUser/setView/openTarget/setActiveTargetId/setTargets/setCapabilities`). Components fetch their own data; store is a shared cache.
- `src/components/rea/rea-app.tsx`: root client component — auth gate (GET /api/auth/me on mount, splash while `!booted`, `<AuthView/>` when null), sticky header (Terminal logo mark + REA wordmark + tagline, desktop nav w/ LayoutDashboard/Binary/MessageSquareText/PlugZap/ShieldCheck/BookOpen, user DropdownMenu w/ sign out, mobile nav in Sheet <md), `<main className="flex-1 w-full max-w-[1600px] mx-auto px-4 md:px-6 py-6">` with AnimatePresence 0.2s fade/slide view switching, sticky footer (`mt-auto`) with "REA Platform — Reverse Engineer Anything · Engine: rea-agents v6.4.0 · Evidence-first analysis" + Docs/Security view-switch links.
- `auth-view.tsx`: centered card, Tabs (Sign in / Create account), manual zod-lite validation (email regex, password ≥ 8), inline destructive Alerts + toasts, framer-motion fade-in, hero copy as specified.
- `dashboard-view.tsx`: 4 staggered stat cards (targets count, engine toolCount, engine healthy badge, recent activity), UploadCard (drag & drop dashed zone + hidden file input + XHR progress bar → on success toast + auto-open workspace + auto POST /analyze), supported-formats badge grid (ELF…unknown), targets table (name/format badge/humanized size/status w/ spinner while running/created/actions: Open · Analyze · Delete via AlertDialog confirm), polls GET /api/targets every 4s while any run is running, skeletons + empty state.
- `workspace-view.tsx`: header (name, FormatBadge, size, truncated sha256 + CopyButton, status), Re-run analysis with optional-goal Popover, Generate documentation button; Tabs Overview | Hex | Strings | Findings | Evidence | Docs. Overview = format-detection card, latest-run card (progress, currentStep, duration, error), findings-by-type counts, limitations card (extracts `result.limitations` defensively); Hex = 256-byte/page monospace viewer (offset | 16 hex bytes | ascii, prev/next, jump-to-offset incl. 0x, file size); Strings = 300ms-debounced search + offset/value/encoding table + pagination (pageSize 100) + max-h-[60vh] scroll; Findings = type Select + search + meta pretty-JSON Collapsible; Evidence = kind-colored ledger cards (observed=emerald/derived=amber/inferred=orange/unknown=rose) w/ confidence/authority/timestamp + payload Collapsible; Docs = markdown render, generate-docs POST with loading skeleton, empty state CTA. Polls target detail every 4s while a run is active.
- `chat-view.tsx`: two-pane (target picker + suggested prompt chips | conversation), GET /api/chat history on target change (toolCalls JSON parsed into trace rows), SSE streaming via `streamChat` with animated "calling REA tool X…" pending rows, tool_result → Collapsible rows (tool + mono preview), assistant chunks accumulated into markdown bubbles, error → toast + fallback line, Enter-to-send textarea, auto-scroll, disabled-while-streaming.
- `capabilities-view.tsx`: engine health card (version/toolCount/healthy badge/detail), host-tools available/missing chips, "Why are native providers unavailable?" Alert with `providers.reason`, searchable 170-tool catalog table (name/title/description, sticky header, slim scroll).
- `security-view.tsx`: posture control cards (enforced/partial severity badges), engine diagnostics (running pulse dot + stderr tail in mono pre), recent threats list (high=rose/medium=amber/low=zinc).
- `docs-view.tsx`: static About page — 5-step pipeline (upload → detect → MCP 170-tool investigation → evidence ledger → AI synthesis), evidence methodology (4 graded badges), security model summary, supported formats grid, responsible-use disclaimer (read-only, never executed).
- `shared.tsx`: FormatBadge (per-format icon+color map), StatusBadge (uploaded/queued/analyzing-spinner/analyzed/failed), EvidenceKindBadge, ConfidenceBadge, SectionCard, EmptyState, TooltipIconButton, CopyButton, Markdown (react-markdown w/ terminal-styled renderers), humanBytes/humanDuration/timeAgo/prettyJson/parseJsonSafe/toastError.
- `src/app/page.tsx` renders `<ReaApp/>` via next/dynamic ssr:false with mono splash; `layout.tsx` metadata → title "REA Platform — Reverse Engineer Anything" + REA description/icons; `globals.css` append-only: body-scoped zinc-950/emerald token overrides (so Radix portals go dark), `@custom-variant dark (&:is(body *, body))` re-scope, `.rea-scroll` slim 8px zinc-700 scrollbar class, `.rea-markdown` first-child trim.
- Responsive: nav → Sheet <md, tables horizontally scrollable, chat/workspaces stack to single column, stat cards 1→2→4 cols.
- A11y: semantic header/nav/main/footer, aria-current on nav, aria-labels + tooltips on every icon-only button, focus-visible rings, sr-only file input labeled.
- Verification: `bun run lint` — all files owned by this task are eslint-clean; `tsc --noEmit` — zero errors in my files. Remaining lint errors are 2× `no-require-imports` in `src/lib/security.ts` (Task 2-foundation file, out of scope for 3-a).

Stage Summary:
- Created: src/lib/api-client.ts; src/store/rea-store.ts; src/components/rea/{rea-app,auth-view,dashboard-view,workspace-view,chat-view,capabilities-view,security-view,docs-view,shared}.tsx
- Modified: src/app/page.tsx (renders ReaApp, dynamic ssr:false); src/app/layout.tsx (metadata only); src/app/globals.css (appended theme + .rea-scroll only — no base vars touched)
- Component contract: store views `dashboard|workspace|chat|capabilities|security|docs`; `openTarget(id)` → workspace view; auth gate blocks shell until GET /api/auth/me resolves; toast via `@/hooks/use-toast` (Toaster already in layout).
- No src/app/api/* or src/server/* files touched.

Contract assumptions the integrator must verify:
1. Envelope strictly `{ok:true,...}`; failures are `{ok:false,error}` (HTTP non-200 tolerated too) — client throws `Error(error)` and views toast it.
2. `GET /api/auth/me` returns `{ok:true,user:null}` (not ok:false) when signed out; either way the auth gate renders.
3. Upload field name is `file` on POST /api/targets; response `{ok,target:{...}}`; the client then auto-POSTs `/api/targets/:id/analyze` with `{}` (optional `{goal}` for re-runs).
4. Workspace Docs tab speculatively calls `GET /api/targets/:id/docs` (present in worklog contract v1) and silently falls back to the empty state if it 404s/errors; generation always goes through `POST /api/targets/:id/report {action:'generate-docs'}` expecting `{ok,docs,summary}`.
5. SSE frames are `data: {json}\n\n`; client tolerates extra event types (e.g. `user_saved` ignored) and `preview` as string or JSON-serializable.
6. `Run.result` limitations read from `result.limitations: string[]` (or `result.summary.limitations`); other shapes render the neutral copy.
7. `formatFamily`, `formatConfidence`, `formatLabel`, `formatDetails` are optional in TargetDetail (Overview tab degrades gracefully); `detectedFormat` is required for FormatBadge.
8. Statuses handled: uploaded/queued/analyzing/running/analyzed/completed/failed (unknown statuses fall back to the neutral "Uploaded" badge style).

---
Task ID: 3-b + 4 (integration)
Agent: main agent
Task: Premium 3D redesign, BYOK provider UI, demo sign-in, thrine embed, E2E verification

Work Log:
- Fixed stale Prisma client (demo login Internal error) via db:generate + dev server restart
- Fixed chat-view TS errors (unknown → String coercion on model SSE event)
- Replaced auth hero 3D scene with thrine.app <model-embed> custom element (next/script module, React 19 custom element, JSX declaration, glow frame)
- Verified 3-b partial work was complete: provider-view (ProviderOnboarding + ProviderSettings), TiltCard/ReaCube/glass/aurora utilities, nav "AI Model" item with platform-mode badge
- Fixed Select controlled/uncontrolled warning (auto-select first target in chat)
- Added onboarding skip persistence (sessionStorage)
- agent-browser E2E verified: auth page + thrine embed render, demo login → onboarding → dashboard, upload demo.db → auto-analysis (101ms, honest limitation: "No REA SQLite tool exists in engine catalog; used platform-local read-only SQLite inspector"), strings/hex tabs, AI chat agent loop (sql_schema + 2 sql_query → evidence-graded DERIVED/INFERRED answer naming alice/bob), AI Model settings, Security posture (9 enforced/1 partial controls), mobile 390x844 responsive, skip persistence, no console errors

Stage Summary:
- Full golden path verified end-to-end in browser
- Demo sign-in: POST /api/auth/demo works, isDemo badge, rate limited 10/15min/ip
- BYOK: /api/provider GET/POST/PUT/DELETE live; keys AES-256-GCM sealed, only last4 returned
- Commits: 9ff0840 (BYOK backend), 8b00d2b (premium redesign + embed)

---
Task ID: 4-a
Agent: frontend-styling-expert
Task: Convert workspace-view into props-driven target-panel.tsx

Work Log:
- Read worklog audit + API contract, full `workspace-view.tsx`, `shared.tsx` helpers and `api-client.ts` types before writing anything.
- Created `src/components/rea/target-panel.tsx` — a self-contained, props-driven `TargetPanel({ targetId, className })` right-side inspector. ZERO imports from `@/store/rea-store` (all state local; no view switching, no dashboard links); framer-motion removed entirely (no page transitions, no motion.span tab underline — active tab styled via `data-[state=active]`).
- Ported ALL six tabs from workspace-view: Overview (format-detection card w/ confidence+family, latest-run card w/ progress bar + currentStep + humanDuration + error Alert, findings-by-type counts fetched from `/findings?limit=500`, limitations extracted defensively from `result.limitations` / `result.summary.limitations`), Hex (256 B/page sticky-header mono table offset | 16 hex bytes (0x00 dimmed, non-printable amber) | ascii, Prev/Next by page, jump input parsing `0x…`/hex, clamped to fileSize-256), Strings (300ms debounced search resetting page, offset/value/encoding table pageSize 100, truncate w/ title attr, Prev/Next pagination footer), Findings (type Select + name/address search, table w/ meta pretty-JSON Collapsible per row), Evidence (kind-colored border-l-4 ledger cards observed=emerald/derived=amber/inferred=orange/unknown=rose, ConfidenceBadge + authority + evidenceId + payload Collapsible in ScrollArea), Docs (silent GET /docs hydration, generate via POST /report {action:'generate-docs'} switching to Docs tab w/ skeleton, empty-state CTA, summary Alert + Markdown render + CopyButton).
- Header: truncated mono filename + FormatBadge + StatusBadge, meta row (humanBytes, sha256 short `slice(0,12)…` + CopyButton for full hash, uploaded timeAgo), action row with two compact h-7 flex-1 buttons: "Re-run analysis" (Popover w/ optional goal Input → POST /api/targets/:id/analyze `{goal}` or `{}`) and "Generate docs" (POST /api/targets/:id/report).
- Polling: GET /api/targets/:id every 4s while `runs[0].status` ∈ {queued,analyzing,running}; interval cleared on unmount/status change via effect cleanup.
- Panel styling for ~400px: local `PanelCard` wrapper over SectionCard (py-3, gap-0, header px-3 via `[&_[data-slot=card-header]]:px-3`, content px-3) for compact paddings; text-xs/text-[11px] throughout; scroll containers use `rea-scroll` + max-h (`calc(100dvh-11rem)` for overview/evidence/docs wrappers, 55vh for hex/strings/findings tables, payload/meta pre blocks); TabsList inside `rea-scroll overflow-x-auto` row with `w-max min-w-full` so all six tabs fit via horizontal scroll; hex table `min-w-[560px]` and findings table `min-w-[440px]` inside overflow-auto for horizontal scrolling; evidence cards truncate long operation/subject/evidenceId with title tooltips.
- Errors: every fetch/POST wrapped in try/catch (or .catch) → `toastError(err, "…")`; docs GET fails silently by design. Empty targetId / loading / not-found states render compact EmptyState/skeletons. A11y kept: aria-labels on search/jump/select inputs, aria-busy on skeleton, title tooltips.
- Verification: `bunx tsc --noEmit | grep target-panel` → empty (grep exit 1, no matches); `bunx eslint src/components/rea/target-panel.tsx` → clean. No other file touched; no new deps.

Stage Summary:
- Created: src/components/rea/target-panel.tsx (only file written by this task).
- Component contract: `export function TargetPanel({ targetId, className }: { targetId: string; className?: string })` — props-driven, no store dependency, safe to embed in the new app shell; reset to Overview tab + refetch whenever `targetId` changes.
- Endpoints called: GET /api/targets/:id (poll 4s while run active), POST /api/targets/:id/analyze {goal?}, GET /api/targets/:id/findings?limit=500 (overview counts + findings tab), GET /api/targets/:id/hex?offset=&length=256, GET /api/targets/:id/strings?q=&page=&pageSize=100, GET /api/targets/:id/evidence, GET /api/targets/:id/docs (silent), POST /api/targets/:id/report {action:'generate-docs'}.
- Reuses shared.tsx: FormatBadge, StatusBadge, EvidenceKindBadge, ConfidenceBadge, SectionCard, EmptyState, CopyButton, Markdown, humanBytes, humanDuration, timeAgo, prettyJson, parseJsonSafe, toastError.

---
Task ID: 5 (redesign v2 — Cursor/Claude-Code style)
Agent: main agent
Task: User redesign directive — (1) strip ALL design from sign-in page, (2) replace messy multi-page dashboard with a structured Cursor/Claude-Code/Codex-style chat-first workspace, (3) only useful chrome: API key settings + free chat.

Work Log:
- Schema: ChatSession.targetId → String? (nullable, free chats), dropped @@unique([targetId,userId]), added updatedAt @default(now())@updatedAt + indexes; db:push OK (data preserved).
- prompts.ts: added freeChatSystemPrompt() (no tools, no tool blocks, RE copilot).
- agent.ts: runAgentLoop accepts target: Target | null — null → free prompt, no target context; defensive redirect if model emits tool block in free chat.
- /api/chat rewritten: GET (no params) = session list w/ _count + target info; GET ?sessionId= = messages; DELETE ?sessionId=; POST {sessionId?|targetId?|message} → new target session per request (no unique constraint anymore); first SSE event session_saved{sessionId,title,targetId}; MAX_SESSIONS_PER_USER=100 guard.
- api-client: SessionSummary/ChatSessionDetail types, listChatSessions/getChatSession/deleteChatSession, streamChat({sessionId?,targetId?,message,onEvent},signal); ChatStreamEvent = closed union (catch-all replaced with {type:"<unknown>"} so switch narrowing works).
- store rewritten: sessions/activeSessionId/draftTargetId (draft = not-yet-persisted chat), targets, inspectorTargetId/inspectorOpen, dialog ('settings'|'system'), providerActive/hasProviderKey; view/onboarding concepts removed.
- auth-view.tsx: rewritten minimal (wordmark + tabs + demo button, plain zinc-950, zero motion/3D/aurora).
- rea-app.tsx: thin boot+gate; refreshProviderInStore() helper exported.
- app-shell.tsx NEW: top bar (context title, model chip→settings, inspector toggle, user menu), sidebar (New chat / CHATS list w/ delete confirm / FILES w/ upload+auto-analyze+draft-chat+inspect), ChatWorkspace main, inline inspector aside (lg+, via useIsDesktop matchMedia) + Sheet version (<lg), VSCode-style status bar (engine dot v6.4.0, model, files/chats counts, DEMO).
- chat-workspace.tsx NEW: history load per session, optimistic send, SSE handling (session_saved pins sidebar w/o aborting stream — skipHistoryLoadRef fix; tool_call/tool_result → collapsible mono trace rows; model chip; error rows), Stop button (AbortController), auto-resize composer w/ Enter=send, free vs target suggestion chips, first-run "platform model — add key" banner, empty states.
- target-panel.tsx (subagent 4-a): props-driven {targetId} inspector, all 6 tabs ported, 4s polling while run active.
- settings-dialog.tsx NEW (wraps ProviderSettings in Dialog); system-dialog.tsx NEW (Engine/Security/About tabs wrapping existing views).
- Deleted: dashboard-view.tsx, workspace-view.tsx, chat-view.tsx. Kept: provider/capabilities/security/docs views as dialog content.
- Fixed during E2E: (a) stream aborted when session_saved flipped activeSessionId (history effect now skipped via ref), (b) duplicate inspector panes (desktop aside + mobile Sheet both rendered — useIsDesktop gate), (c) mobile sidebar trigger icon (rotated Plus → PanelLeft).
- E2E (agent-browser): minimal sign-in ✓, demo login ✓, free chat streams full markdown reply ✓, session pinned in sidebar ✓, file chat runs sql_schema/list_findings w/ trace rows + evidence-graded answer ✓, inspector inline panel all tabs ✓, settings dialog ✓, system dialog (Engine healthy v6.4.0 170 tools) ✓, mobile 390x844 layout + sidebar sheet ✓, upload → auto-analyze → draft target chat ✓, delete chat w/ confirm ✓, console clean (0 errors) ✓. lint 0 problems, tsc clean (excl. pre-existing examples/skills dirs).
- Commit: "feat: Cursor/Claude-Code-style redesign — chat-first IDE shell".

Stage Summary:
- UX now: sign-in (minimal) → chat-first workspace (Cursor-like). Free chat = no tools, honest label "free chat · no tools". File chats run real REA tools. API key via top-bar model chip / sidebar / user menu. Engine+security tucked into System dialog.
- Contracts: GET/POST/DELETE /api/chat reshaped (breaking vs v1 — old targetId-unique upsert gone); SSE first event = session_saved.
- Open items: file compare view, report export,用量 limit display, i18n, per-message token accounting.

---
Task ID: 6 (cron review round 1 — QA + features)
Agent: main agent (webDevReview)
Task: Assess status post-redesign-v2, QA via agent-browser, then add features + styling details.

Work Log:
- QA regression: auth gate ✓, demo login ✓, workspace boot ✓, 0 console errors — stable.
- Backend: PATCH /api/chat (rename, ownership-checked, 1–120 chars); POST /api/chat now returns X-RateLimit-Limit/Remaining headers on the SSE response.
- api-client: apiPatch, renameChatSession, streamChat → { rateLimitRemaining } (parsed from headers).
- store: chatQuota {limit, remaining} | null.
- New src/lib/export.ts: downloadMarkdown + exportChat (transcript w/ tool-call <details>) + exportTargetReport (identity + findings tables + evidence ledger + AI docs).
- app-shell: inline session rename (pencil → input, Enter/Esc/check/X), top-bar "Export chat as Markdown" (visible when a session is active), inspector-header "Export investigation report" download, status-bar quota chip (amber ≤3 remaining, rose 0).
- chat-workspace: scroll-to-bottom floating button (autoscroll only while pinned to bottom; onScroll distance<80), framer-motion fade/slide on message entries, CopyButton on tool output pre.
- BUG FIXED: GET /api/chat returned toolCalls as parsed object while ChatMessageRow types it string → history tool traces disappeared after reload and chat exports skipped them. Route now returns raw string (client already parses defensively).
- BUG FIXED: report export crashed on (f.meta ?? "-").replace — findings API returns meta as parsed object (by design, target-panel prettyJson handles it). export.ts now stringifies non-string meta defensively.
- Verified in browser: rename ✓ (sidebar shows new title), chat export ✓ (9.1KB md w/ 8 details blocks), report export ✓ (demo.db-report.md w/ findings tables), quota chip ✓ ("quota: 19/20 msgs · 5 min"), scroll-to-bottom ✓ (appeared after real scroll event, jump restores distance 0), history traces after reload ✓ (22 DONE rows), console clean ✓, tsc clean ✓, lint 0 problems ✓.

Stage Summary:
- Platform gained: session rename, two Markdown exports (chat + investigation report), live quota feedback, chat UX polish (jump-to-latest, message animations, copyable tool output).
- Known type-lie left as-is: api-client Finding.meta typed string|null but findings route returns parsed object (pre-existing; target-panel handles both; export.ts now defensive).
- Next candidates: file-compare view, per-message token accounting, i18n, streaming token-by-token (SSE deltas), keyboard shortcut palette (Cmd+K).

---
Task ID: 7 (cron review round 2 — QA + Cursor-grade interactions)
Agent: main agent (webDevReview)
Task: Assess status post-round-1, QA via agent-browser, then implement next feature set: token streaming, ⌘K palette, keyboard shortcuts, styling details.

Work Log:
- QA first: dev.log clean (only prisma noise), tsc clean, lint clean. Live browser pass: auth gate ✓, demo login ✓, free chat ✓, file chat with evidence-graded answer ✓, tool trace rows expand w/ copyable output ✓, inspector Overview ✓, system dialog (Engine healthy v6.4.0 · 170 tools) ✓, mobile inspector sheet ✓, 0 page errors — golden path stable → proceeded to new features per round mandate.

Feature 1 — Token-by-token streaming (SSE deltas):
- providers.ts: readProviderSse() minimal SSE line reader; openAiCompatibleStream (OpenAI/DeepSeek/Kimi/GLM), anthropicStream (content_block_delta), geminiStream (streamGenerateContent?alt=sse); providerChatStream dispatcher; ResolvedLlm gains optional callLLMStream(messages,onDelta,opts).
- platform-llm.ts: zaiPlatformChatStream + SseDeltaParser — SDK `stream:true` yields RAW SSE Uint8Array frames (probed via /tmp script: standard OpenAI delta JSON); parser decodes bytes→text, splits data: lines across chunk boundaries, extracts choices[0].delta.content; handles parsed-chunk + full-completion shapes and falls back to non-streamed call.
- agent.ts: AgentEventHandlers.onTurnStart/onAssistantDelta; callTurn() streams when available (one non-streamed retry on stream failure, logged); synthesis turn also streams.
- /api/chat POST: new SSE events `turn_start {turn}` and `delta {text}`; final `assistant` event stays authoritative (client replaces draft verbatim).
- api-client: ChatStreamEvent union extended with turn_start/delta.
- chat-workspace: turnBecameToolRef — on delta append, if content contains ``` the fence index cuts content to prose preamble and drops the rest of that turn's deltas → **raw tool JSON never flashes** (verified live in a file chat with 5 tool calls); turn_start resets the draft; assistant final replaces.

Feature 2 — ⌘K command palette + shortcuts:
- command-palette.tsx NEW (cmdk/shadcn CommandDialog, dark): Actions (new chat ⌘⇧O, upload, toggle sidebar ⌘B, open/close inspector ⌘I, export chat, export report), Recent chats (msg count + timeAgo), Files (chat about / inspect), Settings (API key, engine, sign out); fuzzy filter verified ("demo" → 3 chats + file actions).
- app-shell: global keydown (⌘/Ctrl) K palette · B sidebar · I inspector · ⇧O new chat; top-bar ⌘K chip button; status-bar ⌘K chip; palette mounted with upload/export/logout action callbacks.
- store: sidebarOpen (desktop aside now collapsible via ⌘B, aria-hidden when closed), paletteOpen.

Styling details (mandatory):
- Markdown code blocks now render an IDE-style shell: language label (uppercased mono) + compact copy button header over dark body (CodeBlockShell + extractText in shared.tsx); non-highlighted blocks unchanged.
- CopyButton gained `small` variant (size-5/size-3 icons).
- MessageRow: group hover meta row — timestamp (HH:MM), provider/model on assistant turns, small copy button (Copy assistant/your message); streaming assistant shows emerald block caret after content.
- ThinkingIndicator: 3 staggered bouncing emerald dots + "provider/model · working…" (aria-live polite); only rendered while nothing visible happens (no streamed text, no pending tool row).
- EmptyState: keyboard-hints row (⌘K palette · ⌘B sidebar · ⌘I inspector · ⌘⇧O new chat) in kbd chips under a hairline divider.

Bugs fixed this round:
- Stale Turbopack CSS cache served a malformed utility from a discarded first-draft palette class (a stale cmdk utility class string — redacted: Tailwind scans this log and regenerated the broken CSS) → "Parsing CSS source code failed" build error; class no longer exists in source; touched globals.css to force recompile; fresh load has 0 console errors.
- z-ai SDK stream chunks are raw SSE bytes, not parsed deltas (first implementation produced "Model stream produced no content" + silent non-streamed fallback) → SseDeltaParser; platform model now streams truly token-by-token (verified: mid-stream screenshots show caret + partial markdown; dev.log no longer logs stream failures).

Verification: bunx tsc --noEmit clean; bun run lint 0 problems; browser E2E: palette open/search/select ✓, ⌘B toggle ✓ (sidebar collapses + chat reflows), free-chat streaming w/ caret + Stop ✓, code-block header w/ copy ✓, file-chat streaming w/ 5 REA tools & no JSON flash ✓, history traces after reload ✓ (5 DONE rows), hover copy meta ✓, mobile 390×844 ✓, console 0 errors ✓.

Stage Summary:
- Platform gained: true token streaming for all 6 BYOK providers + platform model (with honest degradation), ⌘K palette, ⌘B/⌘I/⌘⇧O shortcuts, collapsible sidebar, IDE-style code blocks, message hover meta/copy, Claude-Code-style working indicator + caret, kbd-hint empty state.
- SSE protocol: added turn_start/delta events (additive, backward compatible — final assistant event still authoritative).
- Next candidates: per-message token accounting (usage from provider responses), message edit & resend / regenerate, chat search API (server-side), file compare view, i18n.

---
Task ID: 8 (cron review round 3 — P0 fix + Cursor-grade chat interactions)
Agent: main agent (webDevReview)
Task: Assess status, QA via agent-browser, fix bugs / add features + styling details.

Work Log:
- P0 BUG FOUND & ROOT-CAUSED: fresh dev-server boots still 500'd with the old malformed cmdk CSS parse error even though the class was absent from src/. Real cause: Tailwind 4 automatic source detection scans every non-gitignored text file at project root — worklog.md (which quotes the stale class string verbatim) and tool-results/*.txt (persisted read output containing the same) regenerated the broken utility on every compile. Round 2's "touched globals.css" fix was a false positive.
  - Fix: `@import "tailwindcss" source("../")` in globals.css (scan src/ only), redacted the literal class string from worklog.md, deleted the stale tool-results txt.
  - Server remediation: dev server had died mid-recompile; restarted via the system entrypoint `.zscripts/dev.sh` (setsid, detached). Verified stable across multiple minutes; GET / = 200.
  - RULE for future agents: never paste raw Tailwind arbitrary class strings into worklog.md or other root-level text files, and keep tool-results/ out of Tailwind's scan path.
- QA regression (agent-browser): auth gate minimal ✓, demo login ✓, workspace boot ✓, free-chat streaming ✓ (caret + final answer), file-chat with REA evidence grading ✓ (DERIVED/INFERRED + evidence table row), ⌘K palette ✓, mobile 390×844 ✓, 0 console errors → stable, proceeded to features.
- Feature 1 — Edit & resend: POST /api/chat accepts `editMessageId` (isSafeId-checked) → server deletes the edited user turn + everything after it, re-titles the session if it was message #1, runs a fresh agent turn; history window = messages before the edited index (last 20). Client: hover a user message → pencil → inline textarea (Enter=submit, Esc=cancel) with "Save & resend"/Cancel; local transcript truncates optimistically; `user_saved` event now swaps the optimistic local message id for the persisted id so immediate edits address a real server row.
- Feature 2 — Regenerate: POST /api/chat accepts `regenerate:true` (no message) → server drops trailing assistant rows and re-runs the last user turn (history = everything before it). Also works as retry-after-failure because a failed turn persists no assistant row. Client: hover the LAST assistant message → rotate-ccw button; 400 "Nothing to regenerate" guarded client-side (button only renders when a session is active, not streaming, and the entry is the last assistant).
- Both share one refactored `runTurn()` client path (send / edit / regenerate differ only in local transcript commit + request params) — the streaming event machinery is no longer duplicated.
- Feature 3 — Sidebar quick filter: input under "New chat" filters chats (title + file name) and files (name) with live match counts in section headers ("Chats (3)"), mono no-match hints, Esc clears, ⌘F focuses it (auto-opens the sidebar on desktop). Empty-state kbd hints now include ⌘F.
- Styling details: VSCode-style emerald accent bar on the active chat row; composer gains emerald focus glow (border tint + soft outer shadow on focus-within); message bubbles lift border brightness on hover; global `::selection` emerald tint; edit state gets an emerald-accented shell with "editing · later turns will be re-run" hint; MetaButton hover-action component for edit/regenerate in the message meta row.
- Verification: bunx tsc --noEmit clean (src/), bun run lint 0 problems; browser E2E: regenerate re-streamed a different answer (old row provably deleted), edit&resend replaced text + re-titled session + truncated later turns, both PERSIST after reload (server-side), filter narrows both sections with counts, ⌘F focuses the input, 0 page errors throughout.

Stage Summary:
- Platform gained: Cursor-parity conversation controls (edit&resend, regenerate, retry-after-error), sidebar quick filter with ⌘F, active-chat accent, composer focus glow, emerald selection tint.
- SSE/API: POST /api/chat body now supports `editMessageId` and `regenerate` (backward compatible; both ownership-checked, ids validated, truncation bounded by MAX_SESSION_MESSAGES=400).
- Infra note: dev server must be (re)started via `.zscripts/dev.sh`; tailwindcss source detection is now scoped to src/ so markdown/log artifacts can never poison the build again.
- Next candidates: per-message token accounting (provider usage), chat search API (server-side, for >100 sessions), file compare view, i18n, branch-from-message (fork a chat at any turn).

---
Task ID: 9 (cron review round 4 — QA + Cursor-parity branching)
Agent: main agent (webDevReview)
Task: Assess status, QA via agent-browser, then fix bugs / add features + styling details.

Work Log:
- Status assessment: dev server healthy (GET / 200, capabilities endpoint OK), tsc clean, lint clean, git at round-3 commit. Live QA pass: minimal auth page ✓, demo login ✓, free-chat streaming ✓, file-chat evidence-graded answer ✓, inspector all tabs ✓ (findings badges were mid-skeleton in one screenshot — re-captured loaded state: sqlite_table 2 / format 1, correct), quota chip ✓, 0 console errors → phase STABLE → proceeded to features.
- Feature 1 — Fork chat from any message (Cursor-parity branch point):
  - NEW route POST /api/chat/fork {sessionId, messageId}: ownership-checked, copies the target binding + every message up to AND INCLUDING messageId (toolCalls JSON preserved verbatim) into a NEW session titled "Fork · {original}"; original untouched; MAX_SESSIONS_PER_USER + MAX_FORK_MESSAGES(400) guards; audit event chat.session_fork.
  - api-client: forkChatSession(sessionId, messageId) → SessionSummary (unwraps {session} envelope).
  - chat-workspace: fork button (GitFork icon, sky hover) in the hover meta row of BOTH user and assistant messages; hidden while streaming and for unpersisted local- ids; forks via API, prepends summary to store sessions, opens the fork, toast "Chat forked — <title> continues from this point (N messages)".
- Feature 2 — Pinned chats:
  - Prisma: ChatSession.pinned Boolean @default(false) + @@index([userId, pinned, updatedAt]); db:push OK (data preserved).
  - PATCH /api/chat now accepts {pinned?: boolean} (title optional; at least one required). GET list orders pinned desc then updatedAt desc and returns pinned.
  - Sidebar: separate "PINNED" section (Pin icon header) above Chats; pin/unpin button per row — always visible amber on pinned rows, hover-only otherwise; rename/delete moved to per-button group-hover opacity; command palette gained "Pin/Unpin current chat" action; pinned sessions show amber Pin icon in palette results.
- Feature 3 — Drag & drop upload + composer attach:
  - AppShell root: dragenter/over/leave/drop handlers with Files-type guard and depth counter; full-screen overlay (dashed emerald card "Drop to investigate · parsed read-only · never executed", backdrop blur, pointer-events-none so drop reaches the shell).
  - ChatWorkspace composer: paperclip button (left of the mode label) opens the same hidden file picker → upload → auto-analyze → draft target chat. Works for free chats too.
- Styling details: sidebar FILES rows gained an analysis status dot (emerald analyzed/completed, pulsing amber queued/analyzing/running, rose failed, zinc uploaded); fork affordance hover color; pinned-row accent styling. Next.js devIndicators position moved to bottom-right (dev-only "N" button no longer covers the sidebar footer buttons).
- BUGS FIXED this round:
  - forkChatSession returned the {ok, session} envelope as if it were the session → toast showed "undefined" and openSession(undefined) reset the view to a draft chat; also briefly inserted a key-less object into the sidebar list (React "unique key" warning + "1 Issue" badge). Fixed by unwrapping .session in the client helper.
  - next.config.ts devIndicators position (dev-only overlap).
- QA verification (fresh browser session each time — NOTE: `agent-browser console` accumulates logs across reloads; always close+reopen or reload and re-check before trusting "errors"):
  - Fork free chat from assistant message ✓ (toast w/ title+count, fork opened with copied transcript, pinned to sidebar, persists after reload).
  - Fork file chat from assistant message ✓ — node:sqlite check: copied assistant row carries 3762 bytes of toolCalls JSON (REA tool trace preserved); file binding + composer chip intact.
  - Pin → PINNED section appears, row leaves Chats; unpin → section disappears ✓. Palette pin action wired ✓.
  - Drag overlay via synthetic DragEvent(Files) ✓ (dims app, dashed emerald card); real synthetic drop of a text file → upload → auto-analysis → draft chat with file chip ✓; status bar 2→3 files ✓.
  - Mobile 390×844 ✓; fresh-session console 0 errors ✓; tsc clean (src/) ✓; eslint 0 problems ✓.
- Process incident (recovered): a bisect experiment temporarily disabled SidebarBody sections; the automated restore mangled JSX (stray return null + commented block). Rewrote the SidebarBody return block cleanly; verified by tsc + full visual pass. No behavior lost vs. pre-incident working tree.
- Hygiene: tool-results/ (persisted Read outputs) removed from repo and gitignored (they also sit outside the src/-scoped Tailwind scan since round 3, but should never be committed).

Stage Summary:
- Platform gained: git-style chat forking at any message (with preserved REA tool traces + file binding), pinned chats with a dedicated sidebar section, drag & drop file upload with full-screen drop-zone affordance, composer attach button, file analysis status dots.
- API: PATCH /api/chat body now {title?, pinned?}; NEW POST /api/chat/fork; GET /api/chat rows include pinned and order pinned-first.
- Infra rules reaffirmed: never trust agent-browser console buffer across reloads (close+reopen for a clean read); keep generated artifacts out of git and out of Tailwind's scan.
- Next candidates: per-message token accounting (provider usage), server-side chat search (>100 sessions), file compare view, i18n, chat folder/tags, streaming tool-arg preview.

---
Task ID: 10 (cron review round 5 — QA + token accounting + touch usability)
Agent: main agent (webDevReview)
Task: Assess status, QA via agent-browser, fix bugs / add features + styling details.

Work Log:
- Status assessment: dev server healthy, tsc clean, lint clean, git at round-4 commit. Live QA pass: auth gate ✓, demo login ✓, free chat streaming ✓, file chat w/ evidence grading ✓, inspector ✓, 0 console errors → phase STABLE → proceeded to features.

Feature 1 — Per-message token accounting (all 6 BYOK providers + platform):
- providers.ts: new `CallOpts.onUsage?: (TokenUsage) => void` (exported interface). Capture points: OpenAI-compat non-stream (`usage` in response JSON), OpenAI/DeepSeek streams add `stream_options.include_usage` (final frame carries usage w/ empty choices; kimi/glm skip the param to avoid strict-endpoint 400s but still capture usage frames defensively), Anthropic non-stream (`usage`), Anthropic stream (`message_start` → input, `message_delta` → running output), Gemini non-stream + stream (`usageMetadata`, last frame wins).
- platform-llm.ts: z-ai SDK probe (raw SSE dump) PROVED the final stream frame carries `usage:{prompt_tokens,completion_tokens}` — SseDeltaParser.extractUsage now parses it from raw frames AND parsed chunk objects; zaiPlatformChat reads completion.usage.
- BUG (silent): resolveLlmForUser's platform wrapper dropped the third `opts` arg → onUsage never reached zaiPlatformChatStream. Fixed by forwarding opts.
- agent.ts: accumulates usage across ALL ReAct turns (multi-tool turns sum every LLM call), measures wall-clock durationMs (tools included), persists tokensIn/tokensOut/durationMs on the assistant row, returns them in AgentLoopResult.
- /api/chat: new SSE event `usage {tokensIn, tokensOut, durationMs}` (before `assistant`); GET history rows include the three fields; chat Markdown export shows `_tokens: ↑x ↓y · duration: Ns_` per assistant turn.
- UI: MessageMeta gains `↑2.5k ↓125 tok` + `⏱ 8.9s` chips (mono, tooltips explain; absent honestly when provider reports nothing); StatusBar gains `tok: ↑x ↓y` session total (lg+ only) fed by a store.sessionTokens computed from loaded entries; new humanTokens() formatter in shared.tsx.
- DB: ChatMessage.tokensIn/tokensOut/durationMs Int? — db:push OK (data preserved).
- INFRA LESSON: after `prisma db push` + generate, the RUNNING dev server keeps the old client → `chatMessage.create` fails validation on new columns and the persistence catch swallows it (assistant rows silently vanish; stream still shows). Restarting the dev server fixes it. Symptom: streamed answer renders, reload shows nothing.

Feature 2 — Quote-reply: hover Quote button (violet) on user AND assistant messages inserts `> …` blockquote (first 6 lines + `> …` ellipsis) at the top of the composer and focuses it.

Feature 3 — TraceRow args restyling: raw JSON blob → `key=value` pairs (`sql_query  query=SELECT * FROM secrets`), tool name brightened, empty-arg tools stay clean.

BUG FIXED (real UX, affects all touch devices): headless QA browser reported `(hover: none)` and NONE of the group-hover affordances were clickable-visible — investigation showed Tailwind 4 wraps every `hover:`/`group-hover:` variant in `@media (hover: hover)`. On real phones/tablets the message meta rows (edit/regenerate/fork/quote/copy) and sidebar row actions (pin/rename/delete/inspect) were permanently INVISIBLE with no touch alternative. Fix: `.touch-visible { opacity: 1 !important }` inside `@media (hover: none)` in globals.css, applied to MessageMeta + all sidebar row action buttons. Desktop (hover:hover) behavior unchanged; touch devices (and the QA browser) get always-visible affordances.
- DEBUG NOTE for future rounds: agent-browser's headless Chrome reports hover:none/pointer:none — CSSOM checks must recurse into nested @layer/@media rules (top-level sheet.cssRules iteration finds nothing); stale Turbopack CSS survived `touch` + dev-server restart and required a full `.next` wipe (symptom: identical CSS byte length across restarts).

QA verification (fresh browser session): free chat streams + persists `tokensIn 239 / tokensOut 33 / durationMs 8911` in sqlite ✓; file chat meta `glm-platform ↑2.5k ↓125 tok ⏱ 1.9s` + status bar session total ✓; quote-reply inserts blockquote ✓; trace args `query=SELECT * FROM secrets` ✓; sidebar + meta touch-reveal ✓; mobile 390×844 meta/actions reachable ✓; export includes token meta ✓ (code path), tsc clean, lint 0 problems, console 0 errors ✓.

Stage Summary:
- Platform gained: Cursor-parity token usage accounting end-to-end (providers → SSE → DB → message chips + status bar + exports), turn duration, quote-reply, readable tool-arg previews, and hover-gated UI that no longer traps touch users.
- SSE protocol: additive `usage` event (backward compatible).
- Contracts: ChatMessageRow +{tokensIn?, tokensOut?, durationMs?}; POST /api/chat SSE +usage event.
- Next candidates: streaming tool-arg preview while pending (live args), server-side chat search (>100 sessions), file compare view, i18n, chat folders/tags, per-provider cost estimate from token counts.

---
Task ID: 11 (cron review round 6 — QA + message search + cost estimation + shortcuts)
Agent: main agent (webDevReview)
Task: Assess status, QA via agent-browser, fix bugs / add features + styling details.

Work Log:
- Status assessment: dev server healthy, tsc clean (src/), lint clean, git at round-5 commit. Live QA pass (fresh browser): auth page ✓, demo login ✓, free-chat streaming ✓, provider BYOK dialog ✓, Engine&security dialog (healthy v6.4.0 · 170 tools) ✓ → phase STABLE → features.
- BUG FOUND & FIXED (QA): GFM pipe tables rendered as raw "| a | b |" text in chat — react-markdown had no table parser. Installed remark-gfm@4 and wired `remarkPlugins={[remarkGfm]}` in the shared Markdown component. GFM tables, strikethrough (del), and task-list checkboxes (disabled inputs) now render. Table styling polished: max-h-96 scroll container, sticky uppercase header row, cell borders, zebra striping + row hover (globals.css, .rea-markdown table). Verified live: the -O0..-O3 comparison table renders as a real bordered table with code chips in cells.
- Feature 1 — Server-side message search (works past the 100-session sidebar cap):
  - NEW GET /api/chat/search?q=: auth + rate limit (30/min), strips LIKE wildcards, SQLite `contains` over the user's sessions (user+assistant rows, last 2000 scanned), returns ≤40 hits with sessionTitle/target/role/snippet(±48 chars)/createdAt; ranked by earliest match position then newest; audited `chat.message_search`.
  - api-client: MessageSearchHit + searchChatMessages(q).
  - Sidebar: filter input now debounces 350ms and, when q≥2, renders a MESSAGES section (skeleton → hits) above FILES with role icons, session title, timeAgo and <mark>-highlighted emerald snippets; click → openMessageHit() → store.requestJumpToMessage(messageId) + openSession if different chat.
  - chat-workspace: jump-to-message effect — after history load, scrolls the target row to viewport center and flash-highlights it (new .rea-jump-flash keyframes: emerald wash + inset accent bar, 1.8s); motion rows now carry data-message-id.
  - Store: jumpToMessageId + request/clear actions; shortcutsOpen + setter.
- Feature 2 — Cost estimation from token counts (honest "est."):
  - NEW src/lib/pricing.ts: MODEL_PRICING (USD per 1M in/out for all catalog models + glm-platform), prefix fallback lookup ("vendor/model" tolerated), estimateCostUsd(), formatCostUsd() (≥$1 two decimals, <$0.0001 shows "<$0.0001").
  - MessageMeta: amber `$0.0005 est` chip after tok/duration (model from the streaming turn, else the active provider's model; hidden when the model has no pricing entry or usage unknown; tooltip discloses that real bills vary by endpoint/caching/discounts).
  - StatusBar: `tok: ↑x ↓y · ~$0.0005` session total (lg+).
- Feature 3 — Keyboard shortcuts cheat-sheet:
  - NEW ShortcutsDialog (2×2 group grid: Workspace / Composer / Message actions (hover) / Security) with kbd chips; opened by "?" (outside inputs) or from ⌘K palette ("Keyboard shortcuts", Keyboard icon) or the NEW top-bar "?" button.
- Styling details: table zebra/hover, top-bar Keyboard button, filter placeholder now "Filter & search messages…" (content search discoverability), meta token+cost chips whitespace-nowrap (no mobile wrap).
- Hygiene: tool-results/ removed from the repo AGAIN and .gitignore'd (a persisted Read output snuck into the round-6 commit).
- QA verification (fresh browser each pass): search API via in-session fetch returns ranked hits ✓; sidebar MESSAGES (1) with emerald highlight ✓; click → chat opened, view centered on the target message with flash ✓; table renders as real HTML table ✓; cost chips in message meta + status bar ✓ (241/163 tok → ~$0.0005 at glm-platform pricing — math verified); "?" opens cheat-sheet ✓ (4 groups, kbd chips); palette item present ✓; mobile 390×844: layout, streaming chat, touch-visible meta with nowrap cost chip ✓; fresh-session console 0 errors ✓; tsc clean (src/) ✓; eslint 0 problems ✓.

Stage Summary:
- Platform gained: full-text message search across all chats with jump-to-message flash (Cursor-parity), per-turn + per-session cost estimates for every catalog model (clearly labeled estimates), a keyboard cheat-sheet with three entry points, and real GFM markdown tables.
- API: NEW GET /api/chat/search?q= (auth, rate-limited 30/min, audited).
- Contracts: MessageSearchHit; store +{jumpToMessageId, shortcutsOpen}; Markdown component now remark-gfm.
- Next candidates: streaming tool-arg preview while pending (live args), per-message model id persisted on ChatMessageRow (cost accuracy when provider changes mid-session), chat folders/tags, file compare view, i18n, provider pricing refresh date surfaced in UI.
