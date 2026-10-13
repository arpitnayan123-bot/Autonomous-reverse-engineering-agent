"use client";

import * as React from "react";
import { Loader2, Volume2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { toastError } from "@/components/rea/shared";

// ---------------------------------------------------------------------------
// Read-aloud (TTS) — speaker button on assistant messages.
// One global <audio> at a time; starting another message (or navigating)
// stops the previous playback. Text is markdown-stripped client-side and
// re-bounded server-side (POST /api/tts).
// ---------------------------------------------------------------------------

type SpeakState = "idle" | "loading" | "playing";

/** Module-singleton player so only one message ever speaks at a time. */
let currentAudio: HTMLAudioElement | null = null;
let currentStop: (() => void) | null = null;

function stopCurrent() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.src = "";
  }
  currentAudio = null;
  currentStop?.();
  currentStop = null;
}

/**
 * Markdown → speakable prose: code fences become "code block omitted",
 * links/images collapse to their label, tables/quotes/headings flatten.
 */
export function speechText(content: string): string {
  const withoutFences = content.replace(/```[\s\S]*?```/g, " Code block omitted. ");
  return withoutFences
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/^\s*\|.*\|\s*$/gm, (line) => line.replace(/\|/g, " "))
    .replace(/[*_~`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function SpeakButton({ content, streaming }: { content: string; streaming?: boolean }) {
  const [state, setState] = React.useState<SpeakState>("idle");
  const mountedRef = React.useRef(true);
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  // The assistant text keeps streaming while loading — freeze what we speak.
  const textRef = React.useRef("");

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // If this message's audio is the global one, stop it on unmount.
      if (audioRef.current && audioRef.current === currentAudio) stopCurrent();
    };
  }, []);

  const stop = React.useCallback(() => {
    if (audioRef.current && audioRef.current === currentAudio) stopCurrent();
    audioRef.current?.pause();
    audioRef.current = null;
    setState("idle");
  }, []);

  const speak = React.useCallback(async () => {
    stopCurrent();
    const text = textRef.current || speechText(content);
    textRef.current = text;
    if (!text) return;
    setState("loading");
    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.slice(0, 1000) }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? `Read-aloud failed (${res.status}).`);
      }
      const blob = await res.blob();
      if (!mountedRef.current) return;
      const audio = new Audio(URL.createObjectURL(blob));
      audioRef.current = audio;
      currentAudio = audio;
      currentStop = () => {
        // Invoked by another SpeakButton preempting this one.
        setState("idle");
      };
      audio.onended = () => {
        if (audioRef.current === audio) {
          URL.revokeObjectURL(audio.src);
          audioRef.current = null;
          setState("idle");
        }
      };
      audio.onerror = () => {
        if (audioRef.current === audio) {
          audioRef.current = null;
          setState("idle");
          toastError(new Error("Audio playback failed."));
        }
      };
      await audio.play();
      if (!mountedRef.current) {
        audio.pause();
        return;
      }
      setState("playing");
    } catch (error) {
      if (mountedRef.current) {
        setState("idle");
        toastError(error instanceof Error ? error : new Error("Read-aloud failed."));
      }
    }
  }, [content]);

  const onClick = () => {
    if (state === "playing") {
      stop();
    } else if (state === "idle") {
      void speak();
    }
    // "loading" is not clickable — prevents duplicate requests.
  };

  const label =
    state === "playing"
      ? "Stop read-aloud"
      : state === "loading"
        ? "Generating audio…"
        : "Read this message aloud";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={state === "loading"}
      aria-label={label}
      title={label}
      className={cn(
        "grid size-5 place-items-center rounded transition-colors focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none",
        state === "playing"
          ? "text-emerald-400"
          : state === "loading"
            ? "text-zinc-500"
            : "text-zinc-600 hover:text-emerald-400"
      )}
    >
      {state === "loading" ? (
        <Loader2 className="size-3 animate-spin" aria-hidden />
      ) : state === "playing" ? (
        <span className="flex h-3 items-end gap-[2px]" aria-hidden>
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="rea-eq-bar w-[2px] rounded-full bg-emerald-400"
              style={{ animationDelay: `${i * 180}ms` }}
            />
          ))}
        </span>
      ) : (
        <Volume2 className="size-3" aria-hidden />
      )}
    </button>
  );
}
