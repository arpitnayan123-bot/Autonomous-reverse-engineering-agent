#!/usr/bin/env bun
/**
 * REA benchmark runner — executes benchmark tasks against the running agent.
 *
 * Flow per suite run:
 *   1. Resolve the Next.js server: --server URL / REABENCH_SERVER_URL env,
 *      else reuse an already-running server on 127.0.0.1:3000, else spawn
 *      `next dev` on a random port (torn down at exit unless --keep-server).
 *   2. Ensure the benchmark account exists (register once; login afterwards).
 *   3. For each task: upload its fixture as a Target (reusing a previously
 *      uploaded identical fixture — same name + size — to stay under the
 *      upload rate cap), then POST /api/chat and stream the SSE turn.
 *   4. Capture the final assistant message, tool trace, subagent activity,
 *      token usage and duration into results/<task-id>/<runId>.json.
 *
 * Usage:
 *   bun benchmarks/runner.ts [--fast] [--tasks=a,b,c] [--category=binary|web|code|mixed]
 *                            [--difficulty=easy|medium|hard] [--server=URL]
 *                            [--keep-server] [--list]
 *
 * Exit: 0 = every task captured (errors ARE captured results, not failures),
 *       1 = infrastructure failure (server unreachable, auth failed, no tasks).
 */
import { parse } from "smol-toml";
import { readdirSync, readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

// ---------------------------------------------------------------------------
// Constants + CLI
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(import.meta.dir, "..");
const TASKS_DIR = path.join(PROJECT_ROOT, "benchmarks", "tasks");
const RESULTS_DIR = path.join(PROJECT_ROOT, "benchmarks", "results");
const RUNS_DIR = path.join(RESULTS_DIR, "_runs");

/** Fixed benchmark account — registered once, logged in on every later run. */
const BENCH_EMAIL = "rea-bench@example.com";
const BENCH_PASSWORD = "rea-bench-2024!";
const BENCH_NAME = "REA Benchmark";

/** Default server probed before spawning a fresh one. */
const DEFAULT_SERVER = "http://127.0.0.1:3000";

/** Payload caps the server enforces (mirrors src/app/api/chat + security.ts). */
const MAX_MESSAGE_CHARS = 8000;

interface Cli {
  fast: boolean;
  tasks: string[];
  category: string | null;
  difficulty: string | null;
  server: string | null;
  keepServer: boolean;
  list: boolean;
}

function parseCli(): Cli {
  const argv = process.argv.slice(2);
  const cli: Cli = {
    fast: false,
    tasks: [],
    category: null,
    difficulty: null,
    server: process.env.REABENCH_SERVER_URL || null,
    keepServer: false,
    list: false,
  };
  for (const a of argv) {
    if (a === "--fast") cli.fast = true;
    else if (a === "--keep-server") cli.keepServer = true;
    else if (a === "--list") cli.list = true;
    else if (a.startsWith("--tasks=")) cli.tasks = a.slice(8).split(",").map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith("--category=")) cli.category = a.slice(11);
    else if (a.startsWith("--difficulty=")) cli.difficulty = a.slice(13);
    else if (a.startsWith("--server=")) cli.server = a.slice(9);
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return cli;
}

// ---------------------------------------------------------------------------
// Task loading
// ---------------------------------------------------------------------------

export interface BenchTask {
  id: string;
  category: string;
  difficulty: string;
  prompt: string;
  fixture: string; // absolute path
  fixtureName: string;
  fixtureSize: number;
  fixtureSha256: string;
  timeoutMs: number;
  scoring: {
    type: "rubric" | "exact" | "human";
    rubric?: { criterion: string; weight: number }[];
    expected?: string;
  };
  dir: string;
}

function loadOneTask(dir: string): BenchTask {
  const tomlPath = path.join(dir, "task.toml");
  const raw = parse(readFileSync(tomlPath, "utf8")) as {
    task: {
      id: unknown;
      category: unknown;
      difficulty: unknown;
      prompt: unknown;
      fixture: unknown;
      timeout_ms?: unknown;
    };
    scoring: {
      type: unknown;
      rubric?: { criterion: unknown; weight: unknown }[];
      expected?: unknown;
    };
  };
  const id = String(raw.task.id);
  const fixtureRel = String(raw.task.fixture);
  const fixturePath = path.resolve(dir, fixtureRel);
  if (!existsSync(fixturePath)) throw new Error(`${id}: fixture not found: ${fixtureRel}`);
  const buf = readFileSync(fixturePath);
  if (buf.length > 1024 * 1024) throw new Error(`${id}: fixture exceeds 1 MB`);
  if (String(raw.task.prompt).length > MAX_MESSAGE_CHARS) {
    throw new Error(`${id}: prompt exceeds the ${MAX_MESSAGE_CHARS}-char chat cap`);
  }
  const scoringType = String(raw.scoring.type) as BenchTask["scoring"]["type"];
  const rubric = Array.isArray(raw.scoring.rubric)
    ? raw.scoring.rubric.map((r) => ({
        criterion: String(r.criterion),
        weight: Number(r.weight),
      }))
    : undefined;
  return {
    id,
    category: String(raw.task.category),
    difficulty: String(raw.task.difficulty),
    prompt: String(raw.task.prompt),
    fixture: fixturePath,
    fixtureName: path.basename(fixturePath),
    fixtureSize: buf.length,
    fixtureSha256: createHash("sha256").update(buf).digest("hex"),
    timeoutMs: Number(raw.task.timeout_ms ?? 300_000),
    scoring: {
      type: scoringType,
      ...(rubric ? { rubric } : {}),
      ...(raw.scoring.expected !== undefined ? { expected: String(raw.scoring.expected) } : {}),
    },
    dir,
  };
}

function loadAllTasks(): BenchTask[] {
  const dirs = readdirSync(TASKS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_") && !d.name.startsWith("."))
    .map((d) => d.name)
    .sort();
  return dirs.map((name) => loadOneTask(path.join(TASKS_DIR, name)));
}

// ---------------------------------------------------------------------------
// HTTP helpers (cookie-aware)
// ---------------------------------------------------------------------------

interface BenchClient {
  server: string;
  cookie: string;
  userId: string | null;
}

function cookiePairsFrom(res: Response): string[] {
  // getSetCookie is available in Bun's fetch; fall back to the raw header.
  const anyHeaders = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof anyHeaders.getSetCookie === "function") return anyHeaders.getSetCookie();
  const raw = res.headers.get("set-cookie");
  return raw ? [raw] : [];
}

function mergeCookies(current: string, pairs: string[]): string {
  const jar = new Map<string, string>();
  for (const part of current.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) jar.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  for (const pair of pairs) {
    const first = pair.split(";")[0];
    const i = first.indexOf("=");
    if (i > 0) jar.set(first.slice(0, i).trim(), first.slice(i + 1).trim());
  }
  return Array.from(jar.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

async function apiFetch(
  client: BenchClient,
  pathname: string,
  init: RequestInit = {},
  timeoutMs = 30_000
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(`${client.server}${pathname}`, {
      ...init,
      signal: ctrl.signal,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        ...(client.cookie ? { cookie: client.cookie } : {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Server resolution: reuse → probe → spawn
// ---------------------------------------------------------------------------

async function probeServer(base: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/api/auth/me`, { signal: AbortSignal.timeout(4000) });
    // ANY response (200/401/…) proves a live Next.js server.
    return res.status > 0;
  } catch {
    return false;
  }
}

/**
 * Server resolution order: explicit --server → reuse the running dev server
 * on 127.0.0.1:3000 → spawn `next dev` on a random port.
 *
 * Spawn caveat: Next.js 16 keeps a .next/dev/lock, so only ONE dev instance
 * can run per project directory. The spawn fallback therefore only works
 * when no dev server is running at all (the normal case in CI); in a live
 * sandbox the running server is probed and reused instead.
 */
async function resolveServer(cli: Cli): Promise<{ url: string; spawned: ReturnType<typeof Bun.spawn> | null }> {
  if (cli.server) {
    if (!(await probeServer(cli.server))) {
      throw new Error(`--server ${cli.server} is not responding`);
    }
    return { url: cli.server.replace(/\/$/, ""), spawned: null };
  }
  if (await probeServer(DEFAULT_SERVER)) {
    return { url: DEFAULT_SERVER, spawned: null };
  }
  const port = 31000 + Math.floor(Math.random() * 30000);
  const url = `http://127.0.0.1:${port}`;
  console.log(`[runner] no server on ${DEFAULT_SERVER} — spawning next dev on ${port} …`);
  const env = { ...process.env } as Record<string, string | undefined>;
  delete env.NODE_ENV; // next dev must not run with a production env
  const spawned = Bun.spawn(["bun", "run", "next", "dev", "-p", String(port)], {
    cwd: PROJECT_ROOT,
    stdout: "ignore",
    stderr: "ignore",
    env: env as Record<string, string>,
  });
  const ready = await (async () => {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      // Fail fast when the spawned process already died (e.g. dev-lock held).
      if (spawned.exitCode !== null) return false;
      if (await probeServer(url)) return true;
      await Bun.sleep(1000);
    }
    return false;
  })();
  if (!ready) {
    spawned.kill();
    throw new Error(
      `spawned dev server on :${port} did not become ready within 120s. ` +
        `Note: Next.js 16 holds .next/dev/lock while another dev instance runs — ` +
        `the spawn fallback only works when NO dev server is already running for this project. ` +
        `Start the app (bun run dev) or pass --server=<url>.`
    );
  }
  return { url, spawned };
}

// ---------------------------------------------------------------------------
// Auth: fixed benchmark account (register once → login later)
// ---------------------------------------------------------------------------

async function ensureBenchUser(): Promise<BenchClient> {
  const client: BenchClient = { server: "", cookie: "", userId: null };
  return client;
}

async function authenticate(client: BenchClient): Promise<void> {
  const reg = await fetch(`${client.server}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: BENCH_EMAIL, password: BENCH_PASSWORD, name: BENCH_NAME }),
  });
  if (reg.ok) {
    client.cookie = mergeCookies("", cookiePairsFrom(reg));
    const body = (await reg.json().catch(() => null)) as { user?: { id?: string } } | null;
    client.userId = body?.user?.id ?? null;
    console.log(`[runner] registered benchmark account ${BENCH_EMAIL}`);
    return;
  }
  if (reg.status !== 409) {
    const text = await reg.text().catch(() => "");
    throw new Error(`register failed (${reg.status}): ${text.slice(0, 200)}`);
  }
  // Already exists → login.
  const login = await fetch(`${client.server}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: BENCH_EMAIL, password: BENCH_PASSWORD }),
  });
  if (!login.ok) {
    const text = await login.text().catch(() => "");
    throw new Error(`login failed (${login.status}): ${text.slice(0, 200)}`);
  }
  client.cookie = mergeCookies("", cookiePairsFrom(login));
  console.log(`[runner] logged in benchmark account ${BENCH_EMAIL}`);
}

// ---------------------------------------------------------------------------
// Target upload with deterministic reuse (upload rate cap = 20/hour/user)
// ---------------------------------------------------------------------------

async function findExistingTarget(
  client: BenchClient,
  task: BenchTask
): Promise<string | null> {
  const res = await apiFetch(client, "/api/targets");
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as {
    targets?: { id: string; originalName: string; sizeBytes: number }[];
  } | null;
  const hit = body?.targets?.find(
    (t) => t.originalName === task.fixtureName && t.sizeBytes === task.fixtureSize
  );
  return hit?.id ?? null;
}

async function uploadFixture(client: BenchClient, task: BenchTask): Promise<string> {
  const existing = await findExistingTarget(client, task);
  if (existing) return existing;

  const buf = readFileSync(task.fixture);
  for (let attempt = 0; attempt < 3; attempt++) {
    const form = new FormData();
    form.append("file", new File([buf], task.fixtureName, { type: "application/octet-stream" }));
    const res = await apiFetch(client, "/api/targets", { method: "POST", body: form }, 60_000);
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as { target?: { id?: string } } | null;
      if (body?.target?.id) return body.target.id;
    }
    if (res.status === 429) {
      const body = (await res.json().catch(() => null)) as { retryAfterSec?: number } | null;
      const wait = Math.min((body?.retryAfterSec ?? 60) + 2, 600);
      console.log(`[runner] upload rate-limited — waiting ${wait}s …`);
      await Bun.sleep(wait * 1000);
      continue;
    }
    const text = await res.text().catch(() => "");
    throw new Error(`upload failed for ${task.id} (${res.status}): ${text.slice(0, 200)}`);
  }
  throw new Error(`upload kept failing (rate limit?) for ${task.id}`);
}

// ---------------------------------------------------------------------------
// One agent turn over the chat SSE stream
// ---------------------------------------------------------------------------

interface SseEvent {
  type: string;
  [k: string]: unknown;
}

interface TurnCapture {
  finalContent: string;
  sessionId: string | null;
  modelSource: string | null;
  modelId: string | null;
  toolTrace: { tool: string; args: Record<string, unknown>; preview: string }[];
  subagents: {
    id: string;
    task: string;
    tools?: string[];
    maxIterations?: number;
    status?: string;
    durationMs?: number;
    iterations?: number;
    toolsUsed?: number;
    summary?: string;
  }[];
  usage: {
    tokensIn: number | null;
    tokensOut: number | null;
    durationMs: number | null;
    compactionCount: number | null;
  };
  error: string | null;
  eventCount: number;
  httpStatus: number;
}

function parseSseStream(chunk: string, buffer: { rest: string }): SseEvent[] {
  buffer.rest += chunk;
  const events: SseEvent[] = [];
  let idx: number;
  while ((idx = buffer.rest.indexOf("\n\n")) >= 0) {
    const frame = buffer.rest.slice(0, idx);
    buffer.rest = buffer.rest.slice(idx + 2);
    for (const line of frame.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      try {
        events.push(JSON.parse(payload) as SseEvent);
      } catch {
        /* ignore malformed frames — the loop records honest errors elsewhere */
      }
    }
  }
  return events;
}

async function runTaskTurn(
  client: BenchClient,
  task: BenchTask,
  targetId: string
): Promise<TurnCapture> {
  const capture: TurnCapture = {
    finalContent: "",
    sessionId: null,
    modelSource: null,
    modelId: null,
    toolTrace: [],
    subagents: [],
    usage: { tokensIn: null, tokensOut: null, durationMs: null, compactionCount: null },
    error: null,
    eventCount: 0,
    httpStatus: 0,
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    // Client-side hard stop: the turn keeps running server-side (the route is
    // viewer-decoupled by design), but the benchmark must not wait forever.
    const timer = setTimeout(() => ctrl.abort(), task.timeoutMs + 15_000);
    try {
      const res = await fetch(`${client.server}/api/chat`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          ...(client.cookie ? { cookie: client.cookie } : {}),
        },
        body: JSON.stringify({ targetId, message: task.prompt }),
        signal: ctrl.signal,
      });
      capture.httpStatus = res.status;
      if (res.status === 429) {
        const body = (await res.json().catch(() => null)) as { retryAfterSec?: number } | null;
        const wait = Math.min((body?.retryAfterSec ?? 60) + 2, 400);
        console.log(`[runner] chat rate-limited on ${task.id} — waiting ${wait}s …`);
        clearTimeout(timer);
        await Bun.sleep(wait * 1000);
        // Fresh capture for the retried attempt — never mix two streams.
        Object.assign(capture, {
          finalContent: "",
          sessionId: null,
          modelSource: null,
          modelId: null,
          toolTrace: [],
          subagents: [],
          usage: { tokensIn: null, tokensOut: null, durationMs: null, compactionCount: null },
          error: null,
          eventCount: 0,
        });
        continue;
      }
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        throw new Error(`chat failed (${res.status}): ${text.slice(0, 300)}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const buffer = { rest: "" };
      let done = false;
      while (!done) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        for (const ev of parseSseStream(decoder.decode(value, { stream: true }), buffer)) {
          capture.eventCount++;
          switch (ev.type) {
            case "session_saved":
              capture.sessionId = String(ev.sessionId ?? "");
              break;
            case "model":
              capture.modelSource = String(ev.source ?? "");
              capture.modelId = String(ev.model ?? "");
              break;
            case "tool_call":
              capture.toolTrace.push({
                tool: String(ev.tool ?? ""),
                args: (ev.args as Record<string, unknown>) ?? {},
                preview: "",
              });
              break;
            case "tool_result": {
              const last = capture.toolTrace[capture.toolTrace.length - 1];
              const preview = String(ev.preview ?? "");
              if (last && last.tool === ev.tool && !last.preview) last.preview = preview;
              else capture.toolTrace.push({ tool: String(ev.tool ?? ""), args: {}, preview });
              break;
            }
            case "subagent_start":
              capture.subagents.push({
                id: String(ev.id ?? ""),
                task: String(ev.task ?? ""),
                tools: ev.tools as string[] | undefined,
                maxIterations: typeof ev.maxIterations === "number" ? ev.maxIterations : undefined,
              });
              break;
            case "subagent_end": {
              const sub = capture.subagents.find((s) => s.id === ev.id);
              if (sub) {
                sub.status = String(ev.status ?? "");
                sub.durationMs = typeof ev.durationMs === "number" ? ev.durationMs : undefined;
                sub.iterations = typeof ev.iterations === "number" ? ev.iterations : undefined;
                sub.toolsUsed = typeof ev.toolsUsed === "number" ? ev.toolsUsed : undefined;
                sub.summary = String(ev.summary ?? "");
              }
              break;
            }
            case "usage":
              capture.usage.tokensIn = typeof ev.tokensIn === "number" ? ev.tokensIn : null;
              capture.usage.tokensOut = typeof ev.tokensOut === "number" ? ev.tokensOut : null;
              capture.usage.durationMs = typeof ev.durationMs === "number" ? ev.durationMs : null;
              capture.usage.compactionCount =
                typeof ev.compactionCount === "number" ? ev.compactionCount : null;
              break;
            case "assistant":
              capture.finalContent = String(ev.content ?? "");
              break;
            case "error":
              capture.error = String(ev.error ?? "unknown error");
              break;
            case "done":
              done = true;
              break;
          }
        }
      }
      clearTimeout(timer);
      return capture;
    } catch (err) {
      clearTimeout(timer);
      const aborted = ctrl.signal.aborted;
      capture.error = aborted
        ? `benchmark timeout after ${task.timeoutMs + 15_000}ms (turn may still be running server-side)`
        : err instanceof Error
          ? err.message
          : String(err);
      if (aborted) return capture; // timeout is a captured result, not a retry case
      // Transient fetch failures get one more attempt after a short pause.
      if (attempt < 2) {
        await Bun.sleep(5000);
        continue;
      }
      return capture;
    }
  }
  capture.error = capture.error ?? "chat attempts exhausted";
  return capture;
}

// ---------------------------------------------------------------------------
// Result persistence
// ---------------------------------------------------------------------------

function runIdNow(): string {
  return new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .replace(/Z$/, "Z");
}

interface TaskResult {
  runId: string;
  taskId: string;
  category: string;
  difficulty: string;
  prompt: string;
  fixture: { name: string; sizeBytes: number; sha256: string };
  targetId: string;
  sessionId: string;
  modelSource: string | null;
  modelId: string | null;
  finalContent: string;
  toolTrace: { tool: string; args: Record<string, unknown>; preview: string }[];
  subagents: TurnCapture["subagents"];
  usage: TurnCapture["usage"];
  error: string | null;
  timedOut: boolean;
  httpStatus: number;
  sseEventCount: number;
  wallMs: number;
  startedAt: string;
  finishedAt: string;
  task: Pick<BenchTask, "id" | "category" | "difficulty" | "timeoutMs"> & {
    scoring: BenchTask["scoring"];
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cli = parseCli();
  const all = loadAllTasks();
  if (all.length === 0) {
    console.error("No benchmark tasks found under benchmarks/tasks/");
    process.exit(1);
  }
  if (cli.list) {
    for (const t of all) {
      console.log(`${t.id.padEnd(24)} ${t.category.padEnd(6)} ${t.difficulty.padEnd(6)} ${t.scoring.type.padEnd(6)} ${t.fixtureName}`);
    }
    console.log(`\n${all.length} tasks total`);
    return;
  }

  let selected = all;
  if (cli.tasks.length > 0) selected = selected.filter((t) => cli.tasks.includes(t.id));
  if (cli.category) selected = selected.filter((t) => t.category === cli.category);
  if (cli.difficulty) selected = selected.filter((t) => t.difficulty === cli.difficulty);
  if (cli.fast) selected = selected.filter((t) => t.difficulty === "easy" || t.difficulty === "medium");
  if (selected.length === 0) {
    console.error("Task filter matched nothing. Use --list to see available tasks.");
    process.exit(1);
  }

  // Duplicated ids would collide in results/.
  const seen = new Set<string>();
  for (const t of selected) {
    if (seen.has(t.id)) throw new Error(`duplicate task id: ${t.id}`);
    seen.add(t.id);
  }

  const runId = runIdNow();
  mkdirSync(RUNS_DIR, { recursive: true });
  mkdirSync(RESULTS_DIR, { recursive: true });

  const { url, spawned } = await resolveServer(cli);
  const client = await (async () => {
    const c = await ensureBenchUser();
    c.server = url;
    return c;
  })();
  try {
    await authenticate(client);
  } catch (err) {
    spawned?.kill();
    throw err;
  }

  console.log(`[runner] server: ${url}`);
  console.log(`[runner] run ${runId}: ${selected.length} task(s)\n`);

  const manifest: {
    runId: string;
    server: string;
    startedAt: string;
    finishedAt: string;
    tasks: { taskId: string; ok: boolean; wallMs: number; error: string | null }[];
  } = {
    runId,
    server: url,
    startedAt: new Date().toISOString(),
    finishedAt: "",
    tasks: [],
  };

  for (let i = 0; i < selected.length; i++) {
    const task = selected[i];
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    console.log(
      `[${i + 1}/${selected.length}] ${task.id} (${task.category}/${task.difficulty}, timeout ${Math.round(task.timeoutMs / 1000)}s)`
    );
    let result: TaskResult;
    try {
      const targetId = await uploadFixture(client, task);
      const capture = await runTaskTurn(client, task, targetId);
      result = {
        runId,
        taskId: task.id,
        category: task.category,
        difficulty: task.difficulty,
        prompt: task.prompt,
        fixture: {
          name: task.fixtureName,
          sizeBytes: task.fixtureSize,
          sha256: task.fixtureSha256,
        },
        targetId,
        sessionId: capture.sessionId ?? "",
        modelSource: capture.modelSource,
        modelId: capture.modelId,
        finalContent: capture.finalContent,
        toolTrace: capture.toolTrace,
        subagents: capture.subagents,
        usage: capture.usage,
        error: capture.error,
        timedOut: Boolean(capture.error?.includes("benchmark timeout")),
        httpStatus: capture.httpStatus,
        sseEventCount: capture.eventCount,
        wallMs: Date.now() - t0,
        startedAt,
        finishedAt: new Date().toISOString(),
        task: {
          id: task.id,
          category: task.category,
          difficulty: task.difficulty,
          timeoutMs: task.timeoutMs,
          scoring: task.scoring,
        },
      };
      const scoreHint =
        capture.error
          ? `  ⚠ ${capture.error.slice(0, 100)}`
          : `  ✓ ${capture.finalContent.length} chars, ${capture.toolTrace.length} tool call(s), ${capture.usage.tokensIn ?? "?"}→${capture.usage.tokensOut ?? "?"} tok`;
      console.log(`        target=${targetId}${scoreHint}`);
      manifest.tasks.push({ taskId: task.id, ok: !capture.error, wallMs: result.wallMs, error: capture.error });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`        ✗ infrastructure error: ${msg}`);
      manifest.tasks.push({ taskId: task.id, ok: false, wallMs: Date.now() - t0, error: msg });
      // Infrastructure errors (upload failure) skip the capture — record a stub.
      result = {
        runId,
        taskId: task.id,
        category: task.category,
        difficulty: task.difficulty,
        prompt: task.prompt,
        fixture: {
          name: task.fixtureName,
          sizeBytes: task.fixtureSize,
          sha256: task.fixtureSha256,
        },
        targetId: "",
        sessionId: `bench-${runId}-${task.id}`,
        modelSource: null,
        modelId: null,
        finalContent: "",
        toolTrace: [],
        subagents: [],
        usage: { tokensIn: null, tokensOut: null, durationMs: null, compactionCount: null },
        error: msg,
        timedOut: false,
        httpStatus: 0,
        sseEventCount: 0,
        wallMs: Date.now() - t0,
        startedAt,
        finishedAt: new Date().toISOString(),
        task: {
          id: task.id,
          category: task.category,
          difficulty: task.difficulty,
          timeoutMs: task.timeoutMs,
          scoring: task.scoring,
        },
      };
    }

    const dir = path.join(RESULTS_DIR, task.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${runId}.json`), JSON.stringify(result, null, 2));
  }

  manifest.finishedAt = new Date().toISOString();
  writeFileSync(path.join(RUNS_DIR, `${runId}.json`), JSON.stringify(manifest, null, 2));

  const okCount = manifest.tasks.filter((t) => t.ok).length;
  console.log(`\n[runner] done: ${okCount}/${manifest.tasks.length} captured cleanly.`);
  console.log(`[runner] next: bun benchmarks/scorer.ts   (then bun benchmarks/report.ts)`);

  if (spawned) {
    if (cli.keepServer) {
      console.log(`[runner] keeping spawned server (${url}) as requested.`);
    } else {
      console.log(`[runner] shutting down spawned server.`);
      spawned.kill();
    }
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("[runner] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
