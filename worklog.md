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
