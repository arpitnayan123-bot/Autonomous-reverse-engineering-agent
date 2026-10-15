# REA Platform Architecture — Universal Software Intelligence & Reconstruction

> Owner: Arpit Nayan. Status: living document. Last updated with the "strongest RE agent" product brief.

## 1. What REA is

REA is a reverse-engineering agent platform: it takes a **web app, GitHub repo, or binary
file target** and drives an evidence-graded pipeline —
`DISCOVER → COLLECT → UNDERSTAND → MAP → RESEARCH → PLAN → BUILD → CLONE → TEST → VERIFY` —
persisting every intermediate artifact, so a final claim ("here is a runnable clone") is
always backed by inspectable evidence. The doctrine is **evidence-first**:
`OBSERVED > DERIVED > INFERRED > UNKNOWN`, and nothing is simulated. A capability that is
absent reports its absence verbatim and how to enable it.

### Existing substrate (what new capabilities build on)

| Substrate | Location | Notes |
|---|---|---|
| Pipeline DAG runner | `src/server/platform/orchestrator.ts` | waves, retries, approval gates, per-step JSON checkpoints |
| Engine bridge (≈170 tools) | `src/server/engine/rea-bridge.ts` | JSON-RPC/MCP client to the `rea-agents` engine |
| Agent tool registry | `src/server/agent/tools.ts` | 27 tools, `scope: any|target`, dedup, 6 000-char receipts |
| Workspaces + sandbox | `src/server/platform/builder.ts`, `sandbox.ts` | path jail, no-shell tokenizer, allowlist, Docker mode |
| LSP integration | `src/server/platform/lsp.ts` | JSON-RPC over stdio to ts/py/rust/go/c servers |
| Benchmarks | `benchmarks/` | 20 TOML tasks → runner → LLM-judge scorer → `report.html` |
| MCP server | `scripts/mcp-server.ts` | 20 outbound tools over authenticated REST |
| VS Code extension | `vscode/` | tree view, `@rea` chat participant, status bar |
| Auth / vault / audit | `src/lib/security`, `src/server/agent/vault.ts` | scrypt, AES-256-GCM BYOK, audit log |

## 2. Capability map (product brief → subsystems)

### C1. Native RE Toolchain Orchestration — `src/server/retools/`
A pluggable, versioned registry of classical RE tools, each declaring:
`{ id, kind: disassembler|decompiler|debugger|symbolic-executor|analyzer, image, entrypoint,
profile: { memory, cpus, timeoutMs, network, readonly }, license? }`.

- **Execution model** (`retools/runner.ts`): for a given tool + input file, REA picks the
  best available mode — **docker image** (built from `docker/<tool>/Dockerfile`) →
  **local binary on PATH** → honest unavailability error with exact enable instructions.
  Container runs use per-tool profiles (Ghidra: 2 GB; angr: python env) — *not* the 512 MB
  workspace-sandbox posture, because these are analysis (not build) workloads.
- **Normalization**: every invocation returns
  `{ tool, kind, mode, version, argv, exitCode, stdout|stderr (capped), durationMs,
  artifacts[] }`, persisted as `BuildArtifact` rows (`kind: "retool"`) and graded
  `OBSERVED`.
- **Exposure**: agent tools `re_tools` (list + availability) and `re_tool` (run, with
  per-tool operation presets), REST `/api/retools` (+ `/run`), MCP wrappers
  `rea_re_tools` / `rea_re_tool`, and a Capabilities UI card.
- **Backends** (Dockerfiles in `docker/`): `ghidra` (headless analyzer + decompile
  postscript), `rizin` (JSON command output), `pycdc` (Python bytecode decompiler),
  `angr` (symbolic execution scripts). `ida`/`hopper` are declared in the registry but
  stay `license-required` — they activate only when the operator mounts a license.

### C2. Specialized RE AI Models — `src/server/models/`
- **Registry** (`AgentModel` table): task-keyed entries — `function-name-recovery`,
  `struct-reconstruction`, `decompile-cleanup`, `malware-triage`, `binary-similarity` —
  with adapter (`openai-compatible` endpoint or `platform-llm` fallback), status,
  benchmark metrics, priority.
- **Adapter seam** (`models/adapters.ts`): `suggest(task, payload)` resolves
  best available model for the task, degrades honestly to the platform LLM, and marks the
  result provenance `INFERRED` when produced by a model rather than a tool.
- **Training** (`training/`): LoRA fine-tune scripts (Qwen/Llama/DeepSeek via
  peft/transformers), a dataset miner that converts REA's own verified
  Evidence/BuildArtifact history into (decompiled-code, ground-truth) pairs, and an eval
  harness aligned with DecompileBench-style tasks. Training is out-of-band (needs GPU);
  the platform only consumes registered endpoints.

### C3. True Clone & Rebuild Pipeline — orchestrator `clone` stage
The pipeline above gains **CLONE** between BUILD and TEST:

| Pipeline | Clone steps |
|---|---|
| website | `clone:dockerize` — generate `Dockerfile` + `docker-compose.yml` + boot scripts for the reconstruction; `docker build`/boot test when a daemon exists, honest skip otherwise |
| github | `clone:dockerize` (same, from the materialized repo) |
| file (binary) | `clone:decompile` — route the workspace binary through `re_tool` presets (Ghidra → rizin → pycdc by availability) into `clone/` compilable C; `clone:rebuild` — write a build system skeleton and attempt a real compile |

- **Verification** (`verifier.ts`): new `runCloneVerification` — behavioral-equivalence
  checks comparing the original target vs the clone (status codes, text similarity,
  route parity), scored into the same `VerifyCheck` ledger.
- Clone artifacts are ordinary `BuildArtifact`s (`kind: "clone"`), so the existing
  artifact viewer, graph, and audit story cover them.

### C4. Verification & Public Leaderboard
- Benchmark harness already scores 20 tasks (rubric/exact/human; anti-fabrication rule:
  no tool-trace evidence ⇒ ≤ half credit).
- `LeaderboardEntry` table + `/api/leaderboard` + `/leaderboard` UI: entries carry
  `provenance` — our own runs are `OBSERVED`; external systems (RevEng.AI, DecompileBench
  baselines) may only be listed as `INFERRED` **with a methodology citation**. CI
  (`.github/workflows/ci.yml`) runs lint + regression suites + `bench:fast` and blocks
  regressions > 10 points.

### C5. Community Skills Marketplace
- **Manifest v1** (`rea-skill.json`): `{ slug, name, version, description, entry: { system,
  opening }, permissions: string[] (agent-tool allowlist), limits: { toolCalls, workspaceBytes,
  timeoutMs } }` — checksummed (sha256 of canonical form), optional platform signature.
- **Sandboxed runtime** (`src/server/skills/runtime.ts`): a skill run is a constrained
  agent run — tools intersected with `manifest.permissions`, workspace quota, wall-clock
  cap, audit-logged. A skill can never escalate beyond the invoking user's scope.
- **Marketplace**: `Skill` / `SkillInstall` / `SkillRating` tables, `/api/skills`
  (list/publish/install/rate), `/skills` UI, and bundled seeds
  ("Analyze .NET malware", "Reverse a WASM module", "Decompile and rebuild").

### C6. Ecosystem, Security, DX
- MCP server gains `rea_re_tools`, `rea_re_tool`, `rea_skills_list`, `rea_skill_run`,
  `rea_leaderboard_top`.
- `.env.example`, `scripts/setup.sh` one-command setup, `Dockerfile` + `docker-compose.yml`
  for the platform itself; telemetry is **opt-in** (`UserPreference.telemetryOptIn`) and
  counters only (no content).
- Security posture unchanged: scrypt auth, encrypted vault, allowlisted sandboxed
  execution, tenant-isolated audit.

## 3. Delivery waves

| Wave | Deliverable | State |
|---|---|---|
| W0 | Architecture doc, schema (LeaderboardEntry/Skill*/AgentModel) | ✅ |
| W1 | `retools` registry + runner + agent tools + API + capabilities + tests | ✅ |
| W1b | `docker/` backends (ghidra, rizin, pycdc, angr) + compose + docs + MCP wrappers | ✅ |
| W2 | CLONE stage (orchestrator + verifier equivalence) | ✅ |
| W3 | Leaderboard API/UI + benchmark submission + CI workflow | ✅ |
| W4 | Skills marketplace (manifest, runtime, API, UI, seeds) | ✅ |
| W5 | Model registry + adapters + training scripts | ✅ |
| W6 | Ecosystem: `.env.example`, setup script, platform Dockerfile, telemetry opt-in | ✅ |

## 4. Non-negotiable invariants

1. Evidence-first grading; fabricating tool output is a firing offense (the agent loop
   already blocks it — do not weaken `runToolWithDedup` or the fabrication gate).
2. Honest capability reporting: an absent backend says it is absent and how to enable it.
3. Sandboxed by default: RE tool invocations run without network unless the tool profile
   explicitly declares `network: true` (none do today).
4. Small commits, `Arpit Nayan <arpitnayan123@gmail.com>`, tests and lint green before push.
