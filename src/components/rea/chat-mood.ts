/**
 * Chat "mood" — a module-level signal that tells ambient UI (the particle
 * field) what the conversation is doing, WITHOUT re-rendering React.
 *
 * The chat pipeline publishes transitions; the particle canvas subscribes and
 * morphs its formation accordingly. Keeping this outside React state is
 * deliberate: mood changes fire many times per second during streaming and
 * the ambient layer is the only interested party.
 *
 * Moods map to particle formations in <particle-field.tsx>:
 *   idle      → scattered drift + faint constellations (nothing happening)
 *   focus     → soft halo around the composer (user is typing on Home)
 *   thinking  → slow spiral converging on center (turn started, no tokens yet)
 *   streaming → counter-rotating nebula rings (tokens flowing)
 *   tool      → lattice matrix pulse (an engine tool is running)
 *   done      → radial burst, auto-decays back to idle
 */

export type ChatMood =
  | "idle"
  | "focus"
  | "thinking"
  | "streaming"
  | "tool"
  | "done";

type Listener = (mood: ChatMood) => void;

let mood: ChatMood = "idle";
const listeners = new Set<Listener>();
let decayTimer: ReturnType<typeof setTimeout> | null = null;

function clearDecay(): void {
  if (decayTimer !== null) {
    clearTimeout(decayTimer);
    decayTimer = null;
  }
}

function emit(): void {
  for (const fn of listeners) {
    try {
      fn(mood);
    } catch {
      // A broken listener must never take down the publisher.
    }
  }
}

export function getChatMood(): ChatMood {
  return mood;
}

export function subscribeChatMood(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Hard-set the mood. "done" auto-decays to idle after a short celebration. */
export function setChatMood(next: ChatMood): void {
  clearDecay();
  if (next === "done") {
    decayTimer = setTimeout(() => {
      decayTimer = null;
      if (mood === "done") {
        mood = "idle";
        emit();
      }
    }, 2600);
  }
  if (next === mood) return;
  mood = next;
  emit();
}

/**
 * Set a transient mood that decays back to idle unless re-pulsed (used for
 * keystrokes on the Home composer — "focus" follows the typist, then the
 * field settles back to drift).
 */
export function pulseChatMood(next: ChatMood, ttlMs = 1600): void {
  clearDecay();
  if (next !== mood) {
    mood = next;
    emit();
  }
  decayTimer = setTimeout(() => {
    decayTimer = null;
    if (mood === next) {
      mood = "idle";
      emit();
    }
  }, ttlMs);
}
