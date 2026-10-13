# REA Ecosystem Audit — Universal Software Intelligence & Reconstruction Platform

**Scope.** This audit maps the eight capabilities REA needs — Explorer, Reverse Engineer,
Research Agent, Builder, Verification, Universal Connectors, Software Knowledge Graph, and
Agent Orchestration — against the existing REA codebase and the wider open-source
ecosystem, then selects what to integrate, how, and in what priority order.

**Method.** Candidate repositories were inspected through the GitHub API (license SPDX,
stars, last-push recency, archived status, primary language) on 2026-10-14, and candidate
npm packages through the npm registry (version, license, dependency weight). Licensing was
verified from primary sources, not from third-party summaries. Stars were treated as
interest signals, never as selection criteria.

---

## 1. Capability requirements

| # | Capability | Requirements |
|---|------------|--------------|
| 1 | **REA Explorer** | Website crawling (polite, robots-aware), DOM inspection, navigation mapping, content/markdown extraction, technology fingerprinting, screenshots/JS rendering when a browser runtime exists |
| 2 | **REA Reverse Engineer** | Source parsing (multi-language ASTs), import/dependency analysis, architecture discovery, API/endpoint mapping, component identification, evidence-based conclusions (OBSERVED→DERIVED→INFERRED→UNKNOWN) |
| 3 | **REA Research Agent** | Web search with citations, documentation discovery, GitHub repository analysis (metadata, files, languages, license), product comparisons, YouTube metadata, cited reports |
| 4 | **REA Builder** | Isolated workspace execution, guarded file write/read/patch, terminal command execution with allowlists + timeouts + output capture, code generation and debugging driven by the agent loop |
| 5 | **REA Verification** | Functional HTTP checks with assertions, reference-vs-reconstruction comparison (diff), regression detection across runs, quality scoring |
| 6 | **Universal Connector System** | Registry of reusable connectors (built-in, HTTP, MCP), test-connection, invocation with logging, optional exposure of REA capabilities to external coding agents via MCP |
| 7 | **Software Knowledge Graph** | Persistent per-project memory: entities, typed relationships, dependency graphs, provenance links to the evidence ledger, cross-run accumulation |
| 8 | **Agent Orchestration Engine** | Pipeline DAG (DISCOVER→COLLECT→UNDERSTAND→MAP→RESEARCH→PLAN→BUILD→TEST→VERIFY), step retries/timeouts/cancellation, checkpoints, human approval gates, parallel independent steps, progress tracking |

---

## 2. Existing REA functionality (overlap assessment)

REA at round 19 already ships: the real `rea-agents@6.4.0` MCP engine (170 tools: binary
analysis, strings, evidence ledger), SSE chat agent loop with tool calling + transient-fault
recovery + loop guard, file targets with format detection, evidence ledger
(OBSERVED/DERIVED/INFERRED/UNKNOWN), planning UI, encrypted BYOK provider vault
(AES-256-GCM) with platform-LLM self-heal fallback, revocable sessions, audit log, rate
limits, TTS, token/cost accounting.

Consequently:

- **Reuse, don't replace.** The MCP bridge (`src/server/engine/rea-bridge.ts`), the agent
  loop, auth/ownership/rate-limit conventions, and the evidence model are sound. New
  capabilities must plug into these, not parallel them.
- **Gaps.** REA had no website exploration, no multi-language source parsing beyond the
  binary engine, no external research with citations, no code-execution workspace, no
  automated verification, no connector registry, no persistent cross-run knowledge graph,
  and no multi-step orchestration. These are the eight capabilities below.

---

## 3. Candidate ecosystem review (verified 2026-10-14)

### 3.1 firecrawl/firecrawl — TypeScript — AGPL-3.0 — ⚠ restrictive

- ~191k stars, very active, hosted API + self-host.
- **License verdict:** AGPL-3.0. Incorporating any of its source would oblige REA (MIT line
  of code) to become AGPL. **Decision: no code incorporation.** The hosted Firecrawl API is
  offered only as an *optional user-configured HTTP connector* — using a hosted service via
  the user's own key is ordinary client usage, not redistribution.
- Overlap: web crawling/markdown extraction — REA's own crawler covers the core need.

### 3.2 apify/crawlee — TypeScript — Apache-2.0 — good but heavy

- ~26k stars, active, the strongest Node crawling framework (queues, retries, fingerprinting).
- **Decision: considered, not integrated.** Its value is maximal with Playwright tooling and
  request queues; for REA's bounded, robots-aware crawl scopes a lean cheerio-based crawler
  is sufficient and dependency-light. Revisit (P2) if large-scale crawling is ever needed.

### 3.3 microsoft/playwright — TypeScript — Apache-2.0 — integrate as optional runtime

- ~97k stars, extremely active; the reference browser automation framework.
- **Decision: integrate via `playwright-core` (Apache-2.0) with runtime capability
  detection.** If a Chromium binary is present, Explorer gains JS rendering + screenshots and
  Verification gains browser checks; otherwise both degrade honestly to HTTP-level operation
  with an explicit "browser runtime not installed" status and documented setup. No bundled
  browser download happens implicitly.

### 3.4 microsoft/playwright-mcp — TypeScript — Apache-2.0 — reference for connector design

- ~38k stars. An MCP server exposing browser automation.
- **Decision: design reference for the connector registry's MCP transport**; not a runtime
  dependency.

### 3.5 browser-use/browser-use — Python — MIT

- ~117k stars, active, LLM-driven browser agent.
- **Decision: not integrable** (Python, and REA's agent loop already owns LLM-driven
  tool use). Architectural inspiration only.

### 3.6 tree-sitter/tree-sitter — C — MIT — integrate via WASM

- ~27k stars, the standard incremental parser toolkit.
- **Decision: integrate `web-tree-sitter` (MIT) + `tree-sitter-wasms` (Unlicense — public
  domain) for in-process WASM grammars.** Real AST parsing (functions, classes, imports,
  routes) for JS/TS/JSX/TSX/Python/Go/Rust/C/C++/Java with zero native builds. P0.

### 3.7 semgrep/semgrep — OCaml/C/Python — LGPL-2.1 — ⚠ not embeddable

- ~17k stars, active. LGPL-2.1 plus an OCaml/Python runtime REA cannot host.
- **Decision: no incorporation.** REA implements its own evidence-tagged static scans
  (endpoint extraction, secret patterns, framework fingerprints) on top of the tree-sitter
  parse — honestly labeled as heuristics, not semgrep-grade analysis.

### 3.8 OpenHands/OpenHands — Python — MIT; OpenHands/software-agent-sdk — TypeScript — MIT

- ~90k / ~1.2k stars, active. Stateful agent runtime with sandboxed workspaces.
- **Decision: architecture reference for the Builder's workspace isolation and for
  orchestration checkpoints**; not a dependency (the TS SDK assumes its own event-sourced
  runtime that would conflict with REA's engine).

### 3.9 getzep/graphiti — Python — Apache-2.0 — inspiration

- ~31k stars, active, temporal knowledge graphs over Neo4j/FalkorDB for agents.
- **Decision: not integrable** (Python + external graph DB). REA implements an equivalent
  *on SQLite* natively: entities, typed relations, and provenance edges into the evidence
  ledger — matching REA's evidence-first doctrine.

### 3.10 langchain-ai/langgraph — Python — MIT; langchain-ai/langchain — Python — MIT

- ~43k / ~147k stars, active. Graph-structured agent orchestration.
- **Decision: concept reference for the orchestration DAG** (nodes, retries, checkpoints,
  interrupts-for-approval). Python-only; REA's orchestrator is a hand-rolled TypeScript DAG
  runner persisted to SQLite.

### 3.11 Additional discovered pieces (npm)

| Package | Version | License | Role | Decision |
|---|---|---|---|---|
| `cheerio` | 1.2.0 | MIT | HTML parsing/DOM inspection for the crawler | **Integrate (P0)** |
| `web-tree-sitter` | 0.27.1 | MIT | WASM parser runtime | **Integrate (P0)** |
| `tree-sitter-wasms` | 0.1.13 | Unlicense | Prebuilt grammar WASMs (22+ languages) | **Integrate (P0)** |
| `diff` | 9.0.0 | BSD-3-Clause | Text diff for reference-vs-reconstruction comparison | **Integrate (P0)** |
| `@modelcontextprotocol/sdk` | 1.32.1 | MIT | MCP client transport for external connectors | **Integrate (P1)** |
| `playwright-core` | 1.64.0 | Apache-2.0 | Browser automation when a Chromium binary exists | **Integrate (P1, optional runtime)** |
| `madge` | 8.0.0 | MIT | JS/TS dependency graphs | Avoided — duplicates tree-sitter import extraction (redundancy rule) |
| `isomorphic-git` | 1.44.2 | MIT | Pure-JS git clone into workspaces | Deferred (P2) — terminal `git`/tarball download covers the need |

---

## 4. Integration plan by priority

| Priority | Item | Method | License obligation |
|---|---|---|---|
| **P0** | Explorer crawler: polite fetch loop, robots.txt, same-origin scope, SSRF guard, DOM extract, nav map, tech fingerprint | Built on `cheerio` + native fetch | MIT — notice in THIRD_PARTY_NOTICES.md |
| **P0** | Recon parser: tree-sitter AST (functions/classes/imports/routes) + heuristic scans (endpoints, secrets, fingerprints) | `web-tree-sitter` + `tree-sitter-wasms` | MIT + Unlicense — notice |
| **P0** | Research agent: web search (platform), GitHub API analysis, docs discovery (llms.txt, /docs), YouTube oEmbed | Native fetch + platform search | MIT — notice |
| **P0** | Builder workspace: isolated dirs, guarded file ops, allowlisted terminal exec | Native `child_process` + path sandboxing | — (original REA code) |
| **P0** | Verifier: HTTP assertion runner + snapshot diff + regression score | Native fetch + `diff` | BSD-3-Clause — notice |
| **P0** | Knowledge graph: SQLite entities/relations/provenance | Prisma schema extension | — (original) |
| **P0** | Orchestrator: 9-stage DAG, retries, timeouts, cancel, checkpoints, approval gates, parallel independent steps | Original TS service | — (original) |
| **P0** | Schema + APIs + UI for all of the above | Prisma, Next.js route handlers, React views | — (original) |
| **P1** | Browser runtime support (JS rendering + screenshots + browser verification) | `playwright-core` dynamic import + Chromium detection | Apache-2.0 — notice |
| **P1** | Connector registry MCP client transport | `@modelcontextprotocol/sdk` | MIT — notice |
| **P1** | Firecrawl as optional hosted connector | User-key HTTP connector | No redistribution — service usage |
| **P2** | crawlee for large-scale crawling; isomorphic-git for cloneless repos; REA-as-MCP-server exposure | Future | Apache-2.0 / MIT |
| **P3** | Graphiti-style temporal edges; semgrep-grade rule engine | Future | — |

**Redundancy rule applied:** no two integrated components do the same job without a
measurable benefit (madge vs tree-sitter import extraction; crawlee vs lean crawler; langgraph
vs REA DAG runner).

---

## 5. Risks and mitigations

| Risk | Mitigation |
|---|---|
| SSRF via user-supplied crawl URLs | Before any fetch: scheme allowlist (http/https), DNS resolution with private/loopback/link-local/CGNAT rejection, response-IP re-check, no redirects across to blocked ranges |
| Hostile crawled content | Treated as untrusted input: size caps, content-type checks, no execution, plain-text extraction only, stored as inert evidence |
| Hostile discovered source code | Parsed via WASM grammars (no code evaluation); terminal workspace has command allowlist + timeout + output caps; never auto-executes downloaded code |
| Tree-sitter WASM load cost | Grammars loaded lazily per language, cached module-level; parse budget capped per file and per run |
| Unreachable optional capabilities (browser runtime, Firecrawl key) | Capability detection + explicit setup reporting — never fake success |
| DB growth from crawls/graphs | Per-project caps, content truncated to budgets, JSON payload columns kept bounded |
| Concurrent orchestration mutation | One active orchestration per project; steps lock via DB status transitions |

## 6. Compliance summary

- **Incorporated third-party code:** none (all third-party integration is via npm packages
  used as dependencies, which is their intended use and does not require source embedding).
- **Attribution:** `THIRD_PARTY_NOTICES.md` lists every integrated package: project,
  repository, license, changes (none — used as published), and required notices.
- **Copyleft exposure:** zero AGPL/GPL code enters the repository; AGPL-protected services
  are consumed only as hosted APIs through user-provided keys.
- **Untrusted input doctrine:** repository instructions, crawled pages, documents, and
  discovered code are data, never instructions to execute.
