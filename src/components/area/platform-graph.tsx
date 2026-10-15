"use client";

import * as React from "react";
import { X } from "lucide-react";

import type { GraphSnapshotView, GraphNodeView } from "@/lib/platform-client";

/**
 * Knowledge-graph renderer — a deterministic clustered layout (no physics
 * engine needed at this scale): node kinds are arranged around a ring, nodes
 * of a kind fill a fan within their sector, and edges are drawn beneath.
 * Provenance drives stroke colors so OBSERVED/DERIVED/INFERRED/UNKNOWN stay
 * visually honest.
 */

const KIND_ORDER = ["page", "tech", "endpoint", "component", "function", "class", "model", "service", "finding"];

const KIND_COLORS: Record<string, { fill: string; ring: string; label: string }> = {
  page: { fill: "#34d399", ring: "rgba(52,211,153,0.35)", label: "page" },
  tech: { fill: "#2dd4bf", ring: "rgba(45,212,191,0.35)", label: "tech" },
  endpoint: { fill: "#fbbf24", ring: "rgba(251,191,36,0.35)", label: "endpoint" },
  component: { fill: "#a1a1aa", ring: "rgba(161,161,170,0.3)", label: "file" },
  function: { fill: "#5eead4", ring: "rgba(94,234,212,0.3)", label: "function" },
  class: { fill: "#5eead4", ring: "rgba(94,234,212,0.3)", label: "class" },
  model: { fill: "#78716c", ring: "rgba(120,113,108,0.3)", label: "module" },
  service: { fill: "#f5f5f4", ring: "rgba(245,245,244,0.4)", label: "service" },
  finding: { fill: "#f87171", ring: "rgba(248,113,113,0.35)", label: "finding" },
};

const PROV_STROKE: Record<string, string> = {
  OBSERVED: "rgba(52,211,153,0.28)",
  DERIVED: "rgba(251,191,36,0.28)",
  INFERRED: "rgba(45,212,191,0.28)",
  UNKNOWN: "rgba(161,161,170,0.22)",
};

interface Positioned extends GraphNodeView {
  x: number;
  y: number;
  r: number;
}

export function PlatformGraph({ snapshot }: { snapshot: GraphSnapshotView }) {
  const [selected, setSelected] = React.useState<GraphNodeView | null>(null);
  const [kindFilter, setKindFilter] = React.useState<string | null>(null);

  const kinds = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of snapshot.nodes) counts.set(n.kind, (counts.get(n.kind) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => {
      const ia = KIND_ORDER.indexOf(a[0]);
      const ib = KIND_ORDER.indexOf(b[0]);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
  }, [snapshot.nodes]);

  const filtered = kindFilter ? snapshot.nodes.filter((n) => n.kind === kindFilter) : snapshot.nodes;

  const layout = React.useMemo(() => {
    // Clustered ring layout: each kind gets an angular sector.
    const W = 860;
    const H = 560;
    const cx = W / 2;
    const cy = H / 2;
    const positions = new Map<string, Positioned>();
    const activeKinds = kinds.filter(([k]) => !kindFilter || k === kindFilter);
    const sector = (2 * Math.PI) / Math.max(activeKinds.length, 1);

    activeKinds.forEach(([kind, count], ki) => {
      const mid = ki * sector + sector / 2 - Math.PI / 2;
      const ringR = Math.min(230, 120 + count * 2.2);
      const nodes = snapshot.nodes.filter((n) => n.kind === kind);
      const fan = Math.min(sector * 0.86, Math.PI);
      nodes.forEach((n, ni) => {
        const t = nodes.length === 1 ? 0.5 : ni / (nodes.length - 1);
        const angle = mid - fan / 2 + t * fan;
        const rr = ringR * (0.82 + 0.18 * ((ni % 4) / 3)); // slight radial jitter, deterministic
        const key = `${n.kind}\u0000${n.key}`;
        positions.set(key, {
          ...n,
          x: cx + Math.cos(angle) * rr,
          y: cy + Math.sin(angle) * rr * 0.82,
          r: kind === "service" ? 9 : kind === "page" ? 6 : 4.5,
        });
      });
    });

    return { W, H, cx, cy, positions };
  }, [kinds, snapshot.nodes, kindFilter]);

  const visibleEdges = React.useMemo(() => {
    const maxEdges = 500;
    return snapshot.edges
      .filter((e) => {
        const a = layout.positions.get(`${e.fromKind}\u0000${e.fromKey}`);
        const b = layout.positions.get(`${e.toKind}\u0000${e.toKey}`);
        return a && b;
      })
      .slice(0, maxEdges)
      .map((e) => ({
        ...e,
        a: layout.positions.get(`${e.fromKind}\u0000${e.fromKey}`)!,
        b: layout.positions.get(`${e.toKind}\u0000${e.toKey}`)!,
      }));
  }, [snapshot.edges, layout]);

  const nodeKey = (n: GraphNodeView) => `${n.kind}\u0000${n.key}`;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-zinc-800/80 px-3 py-2">
        <button
          type="button"
          onClick={() => { setKindFilter(null); setSelected(null); }}
          className={`rounded-md border px-2 py-0.5 font-mono text-[9px] uppercase tracking-wide transition-colors ${
            kindFilter === null ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300" : "border-zinc-800 text-zinc-500 hover:text-zinc-300"
          }`}
        >
          all ({snapshot.nodes.length})
        </button>
        {kinds.map(([kind, count]) => {
          const c = KIND_COLORS[kind] ?? { fill: "#a1a1aa", ring: "rgba(161,161,170,0.3)", label: kind };
          return (
            <button
              key={kind}
              type="button"
              onClick={() => { setKindFilter(kindFilter === kind ? null : kind); setSelected(null); }}
              className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-[9px] uppercase tracking-wide transition-colors ${
                kindFilter === kind ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300" : "border-zinc-800 text-zinc-500 hover:text-zinc-300"
              }`}
            >
              <span className="size-1.5 rounded-full" style={{ background: c.fill }} aria-hidden />
              {c.label} ({count})
            </button>
          );
        })}
        <span className="ml-auto font-mono text-[9px] text-zinc-600">{visibleEdges.length} edges drawn</span>
      </div>

      {/* Canvas */}
      <div className="min-h-0 flex-1 overflow-hidden">
        <svg viewBox={`0 0 ${layout.W} ${layout.H}`} className="h-full w-full" role="img" aria-label="Knowledge graph">
          <defs>
            <radialGradient id="area-graph-glow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="rgba(16,185,129,0.10)" />
              <stop offset="100%" stopColor="transparent" />
            </radialGradient>
          </defs>
          <rect width={layout.W} height={layout.H} fill="url(#area-graph-glow)" />

          {/* Edges */}
          {visibleEdges.map((e, i) => {
            const mx = (e.a.x + e.b.x) / 2;
            const my = (e.a.y + e.b.y) / 2;
            const dx = mx - layout.cx;
            const dy = my - layout.cy;
            const qx = mx + dx * 0.12;
            const qy = my + dy * 0.12;
            return (
              <path
                key={i}
                d={`M ${e.a.x} ${e.a.y} Q ${qx} ${qy} ${e.b.x} ${e.b.y}`}
                fill="none"
                stroke={PROV_STROKE[e.provenance] ?? "rgba(161,161,170,0.15)"}
                strokeWidth={e.kind === "links-to" ? 0.7 : 1}
                strokeDasharray={e.kind === "depends-on" ? "3 3" : undefined}
              />
            );
          })}

          {/* Nodes */}
          {[...layout.positions.values()].map((n) => {
            const c = KIND_COLORS[n.kind] ?? { fill: "#a1a1aa", ring: "rgba(161,161,170,0.3)", label: n.kind };
            const isSel = selected && nodeKey(selected) === nodeKey(n);
            return (
              <g
                key={nodeKey(n)}
                transform={`translate(${n.x},${n.y})`}
                onClick={() => setSelected(isSel ? null : n)}
                className="cursor-pointer"
                role="button"
                aria-label={`${n.kind}: ${n.label}`}
              >
                <circle r={n.r + (isSel ? 5 : 0)} fill={c.ring} />
                <circle r={n.r} fill={c.fill} opacity={n.provenance === "UNKNOWN" ? 0.45 : 1} />
                {(isSel || n.kind === "service") && (
                  <text y={n.r + 11} textAnchor="middle" fill="#a1a1aa" fontSize="8.5" fontFamily="ui-monospace, monospace">
                    {n.label.length > 34 ? n.label.slice(0, 32) + "…" : n.label}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      {/* Detail card */}
      {selected && (
        <div className="absolute right-3 top-12 w-80 rounded-xl border border-zinc-800 bg-zinc-950/95 p-3 shadow-xl backdrop-blur">
          <div className="flex items-start gap-2">
            <span
              className="mt-1 size-2 shrink-0 rounded-full"
              style={{ background: (KIND_COLORS[selected.kind] ?? { fill: "#a1a1aa" }).fill }}
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <p className="break-words text-xs font-medium text-zinc-100">{selected.label}</p>
              <p className="mt-0.5 font-mono text-[9px] uppercase tracking-wider text-zinc-500">
                {selected.kind} · {selected.provenance.toLowerCase()}
              </p>
            </div>
            <button onClick={() => setSelected(null)} aria-label="Close node detail" className="text-zinc-500 hover:text-zinc-200">
              <X className="size-3.5" aria-hidden />
            </button>
          </div>
          <p className="mt-2 break-all font-mono text-[9.5px] leading-relaxed text-zinc-500">{selected.key}</p>
          {selected.meta != null && (
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-zinc-800 bg-zinc-900/60 p-2 font-mono text-[9.5px] leading-relaxed text-zinc-400 area-scroll">
              {safeJson(selected.meta)}
            </pre>
          )}
        </div>
      )}

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-3 border-t border-zinc-800/80 px-3 py-1.5">
        {Object.entries(PROV_STROKE).map(([prov, stroke]) => (
          <span key={prov} className="inline-flex items-center gap-1.5 font-mono text-[9px] text-zinc-500">
            <span className="h-px w-4" style={{ background: stroke.replace(/0\.\d+\)/, "0.8)") }} aria-hidden />
            {prov.toLowerCase()}
          </span>
        ))}
      </div>
    </div>
  );
}

function safeJson(v: unknown): string {
  try {
    const s = JSON.stringify(v, null, 1);
    return s.length > 2_000 ? s.slice(0, 2_000) + "…" : s;
  } catch {
    return String(v);
  }
}
