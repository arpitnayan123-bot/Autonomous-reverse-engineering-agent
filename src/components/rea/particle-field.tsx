"use client";

import * as React from "react";

import { cn } from "@/lib/utils";
import {
  getChatMood,
  subscribeChatMood,
  type ChatMood,
} from "@/components/rea/chat-mood";

// ---------------------------------------------------------------------------
// ParticleField — the living backdrop behind the chat.
//
// A single canvas renders a field of drifting particles that MORPH between
// formations driven by the conversation mood (chat-mood.ts):
//
//   idle      scattered drift + faint constellation lines
//   focus     soft elliptical halo around the composer (Home typing)
//   thinking  three-arm spiral slowly converging on center
//   streaming counter-rotating nebula rings with radial breathing
//   tool      lattice matrix pulsing in the central region
//   done      radial burst outward, then settling back to drift
//
// Engineering guards: DPR capped at 2, particle count scaled to viewport
// area, rAF paused when the tab is hidden, passive pointer listener, and a
// static single-frame render under prefers-reduced-motion.
// ---------------------------------------------------------------------------

type RGB = readonly [number, number, number];

/** Emerald-dominant palette with teal/amber/zinc accents (REA terminal hues). */
const PALETTE: readonly RGB[] = [
  [16, 185, 129], // emerald-500 (dominant)
  [16, 185, 129],
  [52, 211, 153], // emerald-400
  [20, 184, 166], // teal-500
  [245, 158, 11], // amber-500 (rare accent)
  [161, 161, 170], // zinc-400 (rare neutral)
];

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Stable slot in [0,1) used by every formation so morphs stay coherent. */
  slot: number;
  /** Spiral arm index (thinking). */
  arm: number;
  /** Ring membership (streaming): 0 inner, 1 outer. */
  ring: 0 | 1;
  /** Per-particle radial jitter, keeps formations organic. */
  jitter: number;
  r: number;
  color: RGB;
  /** Twinkle phase + speed. */
  tw: number;
  twSpeed: number;
  /** Drift wander angle (idle). */
  wa: number;
  waSpeed: number;
}

const TAU = Math.PI * 2;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const LINK_DIST = 78;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function ParticleField({ className }: { className?: string }) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let w = 0;
    let h = 0;
    let raf = 0;
    let running = true;
    let disposed = false;
    let t = Math.random() * 100;
    let last = performance.now();
    let mood: ChatMood = getChatMood();
    /** Formation blend weight — ramps toward 1 after every mood change. */
    let weight = 0;
    let particles: Particle[] = [];
    const pointer = { x: -1e5, y: -1e5 };

    const rand = (a: number, b: number) => a + Math.random() * (b - a);

    const makeParticle = (): Particle => {
      const roll = Math.random();
      const color =
        roll < 0.55
          ? PALETTE[0]
          : roll < 0.72
            ? PALETTE[1]
            : roll < 0.82
              ? PALETTE[2]
              : roll < 0.92
                ? PALETTE[3]
                : roll < 0.97
                  ? PALETTE[4]
                  : PALETTE[5];
      return {
        x: rand(0, Math.max(1, w)),
        y: rand(0, Math.max(1, h)),
        vx: rand(-4, 4),
        vy: rand(-4, 4),
        slot: Math.random(),
        arm: 0,
        ring: Math.random() < 0.45 ? 0 : 1,
        jitter: rand(0.75, 1.25),
        r: rand(0.7, 2.3),
        color,
        tw: rand(0, TAU),
        twSpeed: rand(0.5, 1.6),
        wa: rand(0, TAU),
        waSpeed: rand(0.08, 0.35) * (Math.random() < 0.5 ? -1 : 1),
      };
    };

    const spawn = () => {
      const target = Math.round(clamp((w * h) / 16000, 40, 110));
      particles = Array.from({ length: target }, makeParticle);
      particles.forEach((p, i) => {
        p.slot = i / target + rand(-0.004, 0.004);
        p.arm = i % 3;
      });
    };

    const resize = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      const rect = parent.getBoundingClientRect();
      const nextW = Math.max(1, Math.round(rect.width));
      const nextH = Math.max(1, Math.round(rect.height));
      if (nextW === w && nextH === h) return;
      const prevW = w || nextW;
      const prevH = h || nextH;
      w = nextW;
      h = nextH;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (particles.length === 0) {
        spawn();
      } else {
        // Keep the field dense-relative: remap existing particles into the
        // new bounds (spawn-count changes only on large relayouts).
        for (const p of particles) {
          p.x = (p.x / prevW) * w;
          p.y = (p.y / prevH) * h;
        }
        const target = Math.round(clamp((w * h) / 16000, 40, 110));
        while (particles.length < target) particles.push(makeParticle());
        if (particles.length > target) particles.length = target;
      }
      if (reduced) drawFrame(0); // static render for reduced motion
    };

    /** Formation target for a particle, or null when the mood has none. */
    const formationTarget = (p: Particle): [number, number] | null => {
      const scale = clamp(Math.min(w, h) / 760, 0.62, 1.3);
      switch (mood) {
        case "focus": {
          // Soft ellipse hugging the composer region (Home layout: hero above
          // → the entry composer sits around 38-42% of the panel height).
          const cx = w / 2;
          const cy = h * 0.4;
          const rx = clamp(w * 0.3, 150, 400) * p.jitter;
          const ry = clamp(h * 0.07, 40, 84) * p.jitter;
          const a = p.slot * TAU + t * 0.14;
          return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry];
        }
        case "thinking": {
          // Three spiral arms rotating slowly, breathing inward.
          const cx = w / 2;
          const cy = h * 0.46;
          const u = p.slot;
          const angle =
            p.arm * (TAU / 3) + u * 4.6 * Math.PI + t * 0.32 + Math.sin(t * 0.5 + u * 9) * 0.05;
          const radius = (34 + 190 * u) * scale * (0.94 + 0.06 * Math.sin(t * 1.1 + u * 7)) * p.jitter;
          return [cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius * 0.92];
        }
        case "streaming": {
          // Counter-rotating nebula rings with radial breathing.
          const cx = w / 2;
          const cy = h * 0.44;
          const base = p.ring === 0 ? 62 : 132;
          const dir = p.ring === 0 ? 1 : -1;
          const a = p.slot * TAU + t * 0.5 * dir + p.ring * GOLDEN;
          const radius =
            base * scale * (1 + 0.07 * Math.sin(t * 1.3 + p.slot * TAU)) * p.jitter;
          return [cx + Math.cos(a) * radius, cy + Math.sin(a) * radius * 0.94];
        }
        case "tool": {
          // Lattice matrix snapping to a grid in the central region.
          const count = particles.length || 1;
          const cols = Math.max(6, Math.round(Math.sqrt(count * 1.7)));
          const rows = Math.ceil(count / cols);
          const idx = Math.min(count - 1, Math.floor(p.slot * count));
          const col = idx % cols;
          const row = Math.floor(idx / cols);
          const regionW = clamp(w * 0.62, 240, 720);
          const regionH = clamp(h * 0.4, 160, 420);
          const cellW = regionW / Math.max(1, cols - 1 || 1);
          const cellH = regionH / Math.max(1, rows - 1 || 1);
          const pulse = 1 + 0.05 * Math.sin(t * 2 + (col + row) * 0.9);
          const x = w / 2 + (col - (cols - 1) / 2) * cellW * pulse;
          const y = h * 0.44 + (row - (rows - 1) / 2) * cellH * pulse;
          return [x, y];
        }
        default:
          return null;
      }
    };

    /** Center of the active formation (for the ambient core glow). */
    const moodCenter = (): [number, number] | null => {
      if (mood === "thinking" || mood === "streaming" || mood === "tool") {
        return [w / 2, h * (mood === "streaming" || mood === "tool" ? 0.44 : 0.46)];
      }
      if (mood === "focus") return [w / 2, h * 0.4];
      return null;
    };

    const drawFrame = (dt: number) => {
      // --- physics ---
      const spring = 3.4;
      const damping = Math.pow(0.985, dt * 60);
      const hasTarget = !reduced && mood !== "idle" && mood !== "done";
      weight = clamp(weight + (hasTarget ? dt * 0.85 : -dt * 2.2), 0, 1);

      for (const p of particles) {
        const target = hasTarget ? formationTarget(p) : null;
        if (target && weight > 0) {
          p.vx += (target[0] - p.x) * spring * weight * dt;
          p.vy += (target[1] - p.y) * spring * weight * dt;
        }
        // Idle wander: very gentle per-particle drift rotation (quiet at rest).
        if (mood === "idle" || mood === "done" || !target) {
          p.wa += p.waSpeed * dt;
          p.vx += Math.cos(p.wa) * 0.8 * dt;
          p.vy += Math.sin(p.wa) * 0.8 * dt;
        }
        // Pointer repulsion (subtle, everywhere).
        const dxp = p.x - pointer.x;
        const dyp = p.y - pointer.y;
        const d2p = dxp * dxp + dyp * dyp;
        if (d2p < 10000 && d2p > 0.01) {
          const d = Math.sqrt(d2p);
          const k = ((100 - d) / 100) * 26 * dt;
          p.vx += (dxp / d) * k;
          p.vy += (dyp / d) * k;
        }
        p.vx *= damping;
        p.vy *= damping;
        p.x += p.vx * dt * 60 * 0.55;
        p.y += p.vy * dt * 60 * 0.55;
        // Wrap around edges.
        const m = 18;
        if (p.x < -m) p.x = w + m;
        else if (p.x > w + m) p.x = -m;
        if (p.y < -m) p.y = h + m;
        else if (p.y > h + m) p.y = -m;
      }

      // --- render ---
      ctx.clearRect(0, 0, w, h);

      // Ambient core glow while a formation is active.
      const center = moodCenter();
      if (center && weight > 0.02) {
        const breathe = 0.8 + 0.2 * Math.sin(t * 1.2);
        const gr = (mood === "streaming" ? 170 : 130) * scaleOf() * weight * breathe;
        const g = ctx.createRadialGradient(center[0], center[1], 0, center[0], center[1], gr);
        g.addColorStop(0, `rgba(16, 185, 129, ${0.075 * weight})`);
        g.addColorStop(0.55, `rgba(20, 184, 166, ${0.03 * weight})`);
        g.addColorStop(1, "rgba(16, 185, 129, 0)");
        ctx.fillStyle = g;
        ctx.fillRect(center[0] - gr, center[1] - gr, gr * 2, gr * 2);
      }

      // Constellation links only while drifting (alpha fades as a formation
      // takes over — lines across a morph look chaotic).
      if (mood === "idle" && weight < 0.2 && !reduced) {
        ctx.lineWidth = 0.6;
        const linkA = 0.05 * (1 - weight / 0.2);
        ctx.strokeStyle = `rgba(16, 185, 129, ${linkA.toFixed(3)})`;
        ctx.beginPath();
        for (let i = 0; i < particles.length; i++) {
          const a = particles[i];
          for (let j = i + 1; j < particles.length; j++) {
            const b = particles[j];
            const dx = a.x - b.x;
            const dy = a.y - b.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < LINK_DIST * LINK_DIST) {
              ctx.moveTo(a.x, a.y);
              ctx.lineTo(b.x, b.y);
            }
          }
        }
        ctx.stroke();
      }

      // Particles.
      for (const p of particles) {
        const tw = 0.55 + 0.45 * Math.sin(t * p.twSpeed + p.tw);
        const alpha = clamp(0.13 + 0.42 * tw + 0.28 * weight, 0, 0.95);
        const [cr, cg, cb] = p.color;
        // Halo disc: mostly during formations (keeps idle whisper-quiet).
        if (p.r > 1.9 || weight > 0.3) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r * 3.1, 0, TAU);
          ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${((0.035 + 0.045 * tw) * (0.4 + 0.6 * Math.max(weight, 0.4))).toFixed(3)})`;
          ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, TAU);
        ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${alpha.toFixed(3)})`;
        ctx.fill();
      }
    };

    const scaleOf = () => clamp(Math.min(w, h) / 760, 0.62, 1.3);

    const loop = (now: number) => {
      if (!running || disposed) return;
      const dt = clamp((now - last) / 1000, 0.001, 0.05);
      last = now;
      t += dt;
      drawFrame(dt);
      raf = requestAnimationFrame(loop);
    };

    const start = () => {
      if (reduced || !running || disposed) return;
      cancelAnimationFrame(raf);
      last = performance.now();
      raf = requestAnimationFrame(loop);
    };
    const stop = () => {
      cancelAnimationFrame(raf);
    };

    // Mood transitions — burst impulse on "done".
    const unsubscribe = subscribeChatMood((next) => {
      if (reduced) {
        mood = next;
        return;
      }
      mood = next;
      weight = 0; // every formation ramps in fresh
      if (next === "done") {
        const cx = w / 2;
        const cy = h * 0.45;
        for (const p of particles) {
          const dx = p.x - cx;
          const dy = p.y - cy;
          const d = Math.max(12, Math.hypot(dx, dy));
          const kick = rand(2.2, 6.5);
          p.vx += (dx / d) * kick;
          p.vy += (dy / d) * kick;
        }
      }
    });

    const onPointerMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointer.x = e.clientX - rect.left;
      pointer.y = e.clientY - rect.top;
    };
    const onPointerLeave = () => {
      pointer.x = -1e5;
      pointer.y = -1e5;
    };
    const onVisibility = () => {
      if (document.hidden) {
        running = false;
        stop();
      } else {
        running = true;
        start();
      }
    };

    const ro = new ResizeObserver(resize);
    ro.observe(canvas.parentElement ?? canvas);
    resize();
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("pointerdown", onPointerMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onPointerLeave);
    document.addEventListener("visibilitychange", onVisibility);
    start();

    return () => {
      disposed = true;
      running = false;
      stop();
      unsubscribe();
      ro.disconnect();
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerdown", onPointerMove);
      document.documentElement.removeEventListener("pointerleave", onPointerLeave);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className={cn("block h-full w-full", className)}
      aria-hidden="true"
    />
  );
}
