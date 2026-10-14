/**
 * Subagent tracking for the REA agent loop.
 *
 * A subagent is a nested `runAgentLoop` run (depth 2) spawned by the primary
 * loop through the `spawn_subagent` tool: same target, same chat session
 * (therefore the SAME sandboxed workspace), but a FRESH message history and
 * a restricted tool allowlist. This module owns the per-session bookkeeping:
 *
 * - concurrency: at most SUBAGENT_MAX_CONCURRENT active subagents per chat
 *   session — the loop refuses further spawns with an honest error while the
 *   cap holds (the cap is per SESSION, shared across turns, not per loop);
 * - observability: every subagent gets its own id, tool trace, usage
 *   counters, iteration count and wall-clock duration, reported to the UI
 *   through the onSubagentStart / onSubagentDelta / onSubagentEnd events;
 * - cancellation: each subagent carries an AbortController; the parent loop
 *   composes it with its own signal, and `cancelAll` aborts every active
 *   subagent of the session at once (parent cancellation propagation);
 * - isolation: failure of one subagent never crashes the parent loop — the
 *   runner turns it into an honest error tool result.
 *
 * This module deliberately imports NOTHING from agent.ts at runtime (the
 * tool-trace shape below is structural): the agent loop owns the recursive
 * execution; this file stays a pure bookkeeping layer.
 */

/** Max concurrently ACTIVE subagents per chat session. */
export const SUBAGENT_MAX_CONCURRENT = 3;

/** Recursion depth of nested agent loops. Depth 1 = the primary loop;
 * depth 2 = a subagent. spawn_subagent at depth 2 is refused — subagents
 * cannot spawn sub-subagents. (Enforced in agent.ts; documented here for
 * the module that owns subagent records.) */
export const SUBAGENT_DEPTH_LIMIT = 2;

export type SubagentStatus = "running" | "completed" | "failed" | "cancelled";

/** One tool execution inside a subagent run (structurally AgentToolTrace). */
export interface SubagentToolTraceEntry {
  tool: string;
  args: Record<string, unknown>;
  result: string;
}

export interface SubagentUsage {
  tokensIn: number | null;
  tokensOut: number | null;
}

/** Validated spawn_subagent arguments (see parseSubagentArgs in tools.ts). */
export interface SubagentSpec {
  task: string;
  tools: string[];
  maxIterations: number;
}

export interface SubagentRecord {
  id: string;
  sessionId: string;
  task: string;
  /** Tool allowlist for this run (validated against the registry). */
  tools: string[];
  /** Iteration budget for this run (1..15). */
  maxIterations: number;
  /** Nesting depth of the subagent's own loop (always SUBAGENT_DEPTH_LIMIT today). */
  depth: number;
  status: SubagentStatus;
  startedAt: number;
  durationMs: number | null;
  toolTrace: SubagentToolTraceEntry[];
  usage: SubagentUsage;
  iterations: number;
  result: string | null;
  error: string | null;
}

export interface SubagentStartInfo {
  id: string;
  task: string;
  tools: string[];
  maxIterations: number;
}

export interface SubagentEndInfo {
  id: string;
  status: "completed" | "failed" | "cancelled";
  durationMs: number;
  iterations: number;
  toolsUsed: number;
  /** First chars of the final report (completed) or the error (failed). */
  summary: string;
}

let subagentCounter = 0;

function nextSubagentId(): string {
  subagentCounter += 1;
  return `sub-${Date.now().toString(36)}-${subagentCounter.toString(36)}`;
}

/**
 * Per-session subagent bookkeeping. Instances are shared per session via
 * `subagentManagerFor` so the concurrency cap holds ACROSS turns of the same
 * chat session (the platform runs at most one turn per session at a time, but
 * detached turns and direct tool surfaces must observe the same cap).
 */
export class SubagentManager {
  readonly sessionId: string;
  private readonly records = new Map<string, SubagentRecord>();
  private readonly controllers = new Map<string, AbortController>();

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /** Number of currently ACTIVE (running) subagents. */
  activeCount(): number {
    let n = 0;
    for (const r of this.records.values()) if (r.status === "running") n++;
    return n;
  }

  /** True when another subagent may start right now. */
  canSpawn(): boolean {
    return this.activeCount() < SUBAGENT_MAX_CONCURRENT;
  }

  /**
   * Register a new active subagent. Returns null (and changes nothing) when
   * the session already has SUBAGENT_MAX_CONCURRENT active subagents — the
   * caller turns that into an honest tool-result refusal.
   */
  begin(spec: SubagentSpec, depth: number): SubagentRecord | null {
    if (!this.canSpawn()) return null;
    const record: SubagentRecord = {
      id: nextSubagentId(),
      sessionId: this.sessionId,
      task: spec.task,
      tools: [...spec.tools],
      maxIterations: spec.maxIterations,
      depth,
      status: "running",
      startedAt: Date.now(),
      durationMs: null,
      toolTrace: [],
      usage: { tokensIn: null, tokensOut: null },
      iterations: 0,
      result: null,
      error: null,
    };
    this.records.set(record.id, record);
    this.controllers.set(record.id, new AbortController());
    return record;
  }

  /** Abort controller for an active subagent (cancellation propagation). */
  controllerFor(id: string): AbortController {
    const c = this.controllers.get(id);
    if (!c) throw new Error(`no active subagent ${id} in session ${this.sessionId}`);
    return c;
  }

  /**
   * Abort EVERY active subagent of this session (parent cancellation
   * propagation). Subagents observe this through their composed abort signal
   * at the next iteration boundary or LLM-call check. Records are marked
   * cancelled immediately — an aborted subagent is no longer active, so the
   * concurrency slot frees at once and repeated calls are no-ops.
   */
  cancelAll(reason: string): number {
    let n = 0;
    for (const [id, record] of this.records) {
      if (record.status !== "running") continue;
      record.status = "cancelled";
      record.error = reason;
      this.controllers.get(id)?.abort(new Error(reason));
      this.controllers.delete(id);
      n++;
    }
    return n;
  }

  /** Merge a completion/failure patch into a record (no-op when unknown). */
  finish(
    id: string,
    patch: Partial<Pick<SubagentRecord, "status" | "durationMs" | "usage" | "toolTrace" | "iterations" | "result" | "error">>
  ): SubagentRecord | null {
    const record = this.records.get(id);
    if (!record) return null;
    Object.assign(record, patch);
    if (patch.status !== "running") this.controllers.delete(id);
    return record;
  }

  recordFor(id: string): SubagentRecord | null {
    return this.records.get(id) ?? null;
  }

  /** Currently active records (concurrency diagnostics / UI surfacing). */
  activeRecords(): SubagentRecord[] {
    return [...this.records.values()].filter((r) => r.status === "running");
  }

  allRecords(): SubagentRecord[] {
    return [...this.records.values()];
  }
}

// ---------------------------------------------------------------------------
// Per-session registry (shared instances so the cap is per SESSION)
// ---------------------------------------------------------------------------

/** Bounded: sessions are chat-scoped and finite; evict the oldest beyond the cap. */
const SUBAGENT_MANAGER_MAX_SESSIONS = 200;
const sessionManagers = new Map<string, SubagentManager>();

/** Shared SubagentManager for a chat session — created on first use. */
export function subagentManagerFor(sessionId: string): SubagentManager {
  let m = sessionManagers.get(sessionId);
  if (!m) {
    m = new SubagentManager(sessionId);
    if (sessionManagers.size >= SUBAGENT_MANAGER_MAX_SESSIONS) {
      const oldest = sessionManagers.keys().next().value;
      if (oldest !== undefined) sessionManagers.delete(oldest);
    }
    sessionManagers.set(sessionId, m);
  }
  return m;
}

/** Test seam: drop every per-session manager (isolation between suites). */
export function resetSubagentManagersForTests(): void {
  for (const m of sessionManagers.values()) {
    m.cancelAll("subagent registry reset");
  }
  sessionManagers.clear();
}
