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
