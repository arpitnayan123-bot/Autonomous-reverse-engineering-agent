import { TurnAbortedError } from "./platform-llm";

/**
 * Turn lifetime control, decoupled from the SSE viewer connection.
 *
 * Why this exists: the external preview proxy severs long responses (~30s
 * total, measured on real repository-analysis turns), and treating that
 * viewer disconnect as a cancellation order used to cancel HEALTHY turns
 * mid-synthesis — the model "lost contact" precisely because the server
 * threw away its own still-running work. A viewer dying is a TRANSPORT
 * event, not an intent; only an explicit user stop (or the safety deadline)
 * may cancel a turn now.
 *
 * The turn registry lets the stop endpoint find a turn whose viewer is gone.
 * Keyed by sessionId — one in-flight turn per session is already enforced by
 * the route's single-writer guard, so the map never holds two entries for
 * the same session.
 */

/** Hard cap for one turn regardless of viewer state (safety, not UX). */
export const TURN_SAFETY_DEADLINE_MS = 10 * 60_000;

/**
 * The turn registry MUST survive module re-evaluation. Next.js dev (HMR /
 * on-demand route compilation) can evaluate turn-control.ts once per route
 * bundle, so a module-level Map let /api/chat/stop look up a FRESH empty map
 * while the turn lived in the chat route's instance — Stop silently no-opped
 * (stopped:false) and the server kept generating for minutes after the user
 * cancelled (reproduced live: a "stopped" essay turn ran another 3.5 min and
 * persisted as complete). Backing the map with globalThis — the same pattern
 * as the Prisma client singleton in lib/db.ts — makes the registry a process
 * singleton in every module instance; behavior in production (single
 * instance anyway) is unchanged.
 */
const GLOBAL_TURNS_KEY = Symbol.for("rea.activeTurns");

const globalScope = globalThis as unknown as { [GLOBAL_TURNS_KEY]?: Map<string, TurnControl> };

export const activeTurns: Map<string, TurnControl> =
  globalScope[GLOBAL_TURNS_KEY] ?? (globalScope[GLOBAL_TURNS_KEY] = new Map());

export class TurnControl {
  private controller = new AbortController();
  private stoppedFlag = false;
  private reasonValue: string | null = null;
  private deadline: ReturnType<typeof setTimeout> | null = null;

  constructor(deadlineMs: number = TURN_SAFETY_DEADLINE_MS) {
    if (Number.isFinite(deadlineMs) && deadlineMs > 0) {
      this.deadline = setTimeout(() => {
        this.stop("Turn exceeded the safety deadline and was stopped");
      }, deadlineMs);
      // A deadline must never keep the process alive on its own.
      this.deadline.unref?.();
    }
  }

  /** Abort signal for LLM calls — fires ONLY on explicit stop/deadline. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** True once the turn has been explicitly stopped or hit its deadline. */
  get stopped(): boolean {
    return this.stoppedFlag;
  }

  /** Human-readable stop reason, or null while running. */
  get reason(): string | null {
    return this.reasonValue;
  }

  /** Explicit cancellation (user stop / deadline). Idempotent. */
  stop(reason = "Turn cancelled by user"): void {
    if (this.stoppedFlag) return;
    this.stoppedFlag = true;
    this.reasonValue = reason;
    if (this.deadline) clearTimeout(this.deadline);
    this.deadline = null;
    this.controller.abort();
  }

  /** Release the deadline timer once the turn finished on its own. */
  dispose(): void {
    if (this.deadline) clearTimeout(this.deadline);
    this.deadline = null;
  }
}
