/**
 * Client-side classification of AREA tool-execution outcomes and turn-level
 * system notes — the UI's source of truth for honest status rendering.
 *
 * These classifiers MIRROR the server-side markers exactly:
 *  - TOOL_REFUSAL_MARKER = "NOT EXECUTED" (src/server/agent/tools.ts) —
 *    every refused tool intent's persisted/streamed result starts with it;
 *  - tool failures surface as result strings starting "Error" (invalid args,
 *    SSRF-guard refusals, timeouts, non-SELECT SQL, …) or the area_tool MCP
 *    envelope "AREA tool <name> → isError: true";
 *  - finalizeTurnContent / formatInterruptedTurnContent (src/server/agent/
 *    agent.ts) append their system notes at the END of the persisted
 *    assistant content.
 *
 * The regression suite (scripts/regression-agent.ts, section H) locks these
 * classifiers to the LIVE server constants and note builders so the mirror
 * cannot silently drift. Pure functions only — no framework, no server
 * imports — so both the React UI and the Bun regression harness consume them.
 */

export type ToolOutcome = "running" | "executed" | "refused" | "failed";

export interface ToolOutcomeStep {
  /** Live row awaiting its tool_result (streaming) — persisted rows never are. */
  pending?: boolean;
  /** The tool result text (or its leading slice — prefixes are what matter). */
  preview?: string | null;
}

/**
 * Mirror of src/server/agent/tools.ts TOOL_REFUSAL_MARKER. Locked to the
 * live constant by regression section H (H1) — change both together.
 */
export const TOOL_REFUSAL_MARKER = "NOT EXECUTED";

/** Mirror of agent.ts's interrupted-turn note opener (H5 locks it). */
export const INTERRUPTED_TURN_MARKER = "Turn interrupted before completion:";

/** Mirror of agent.ts finalizeTurnContent's note opener (H6 locks it). */
export const INTEGRITY_NOTE_MARKER = "Integrity note (system):";

/**
 * Classify one tool-trace row into the four honest outcomes:
 *  - "running"  — call in flight (spinner + elapsed timer);
 *  - "refused"  — the platform did NOT run it (availability boundary);
 *  - "failed"   — the platform ran it and it returned an error;
 *  - "executed" — genuine platform execution with real output (including a
 *    cross-turn dedup reuse, which prepends the ORIGINAL genuine result).
 */
export function classifyToolOutcome(step: ToolOutcomeStep): ToolOutcome {
  if (step.pending) return "running";
  const text = (step.preview ?? "").trimStart();
  if (text.startsWith(TOOL_REFUSAL_MARKER)) return "refused";
  if (/^Error\b/.test(text) || /^AREA tool .*isError: true/.test(text)) return "failed";
  return "executed";
}

export type TurnNoteKind = "interrupted" | "integrity";

export interface TurnNote {
  kind: TurnNoteKind;
  /** The raw note text exactly as the server appended it (blockquote lines). */
  note: string;
  /** The assistant content WITHOUT the note (what the prose renderer shows). */
  body: string;
}

/**
 * Extract a turn-level system note (interruption / integrity gate) that the
 * server appended at the END of the assistant content. Returns null when the
 * content carries no note (clean turn). Both builders append the note after
 * the visible text, so splitting at the marker line preserves the prose.
 */
export function extractTurnNote(content: string): TurnNote | null {
  if (!content) return null;
  const idxIntegrity = content.indexOf(INTEGRITY_NOTE_MARKER);
  const idxInterrupted = content.indexOf(INTERRUPTED_TURN_MARKER);
  // The two notes never co-occur (a turn is either interrupted or finalized);
  // if both strings somehow appear, the earliest wins.
  let idx = -1;
  let kind: TurnNoteKind = "interrupted";
  if (idxIntegrity >= 0 && (idxInterrupted < 0 || idxIntegrity < idxInterrupted)) {
    idx = idxIntegrity;
    kind = "integrity";
  } else if (idxInterrupted >= 0) {
    idx = idxInterrupted;
    kind = "interrupted";
  }
  if (idx < 0) return null;
  // Start of the line containing the marker (the note opens as a blockquote).
  const lastNl = content.lastIndexOf("\n", idx);
  const lineStart = lastNl < 0 ? 0 : lastNl + 1;
  return {
    kind,
    note: content.slice(lineStart).trim(),
    body: content.slice(0, lineStart).trimEnd(),
  };
}

/**
 * Plain-text lines of a note for banner rendering: blockquote markers, bold
 * emphasis and the ⚠️ warning prefix stripped, empty lines dropped, order
 * preserved. Marker phrases ("Turn interrupted before completion:",
 * "Integrity note (system):") are KEPT — callers strip the redundant title
 * phrase themselves (see TurnNoteBanner).
 */
export function turnNoteLines(note: string): string[] {
  return note
    .replace(/^>\s?/gm, "")
    .replace(/\*\*/g, "")
    .split("\n")
    .map((l) => l.replace(/^⚠️\s*/, "").trim())
    .filter(Boolean);
}
