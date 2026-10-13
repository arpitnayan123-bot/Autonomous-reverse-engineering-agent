"use client";

import * as React from "react";
import ReactMarkdown from "react-markdown";
import {
  motion,
  useMotionTemplate,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
  type MotionStyle,
} from "framer-motion";
import {
  Boxes,
  Check,
  CircuitBoard,
  Coins,
  Copy,
  Database,
  FileCode,
  FileQuestion,
  FileText,
  Image as ImageIcon,
  Loader2,
  Network,
  Package,
  PackageOpen,
  ScrollText,
  Smartphone,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { toast } from "@/hooks/use-toast";

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function humanBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = "B";
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function humanDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m ${rest}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** Safe JSON pretty-print; returns the raw string when it is not JSON. */
export function prettyJson(raw: string | null | undefined): string {
  if (!raw) return "";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export function parseJsonSafe<T = unknown>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Error toast helper — keeps messaging consistent across views. */
export function toastError(err: unknown, fallback = "Something went wrong") {
  const message = err instanceof Error ? err.message : fallback;
  toast({ variant: "destructive", title: fallback, description: message });
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

const FORMAT_STYLES: Record<string, { icon: LucideIcon; className: string }> = {
  elf: { icon: CircuitBoard, className: "text-amber-400 border-amber-500/30 bg-amber-500/10" },
  pe: { icon: CircuitBoard, className: "text-amber-400 border-amber-500/30 bg-amber-500/10" },
  macho: { icon: CircuitBoard, className: "text-amber-400 border-amber-500/30 bg-amber-500/10" },
  wasm: { icon: Boxes, className: "text-emerald-400 border-emerald-500/30 bg-emerald-500/10" },
  evm: { icon: Coins, className: "text-amber-400 border-amber-500/30 bg-amber-500/10" },
  solidity: { icon: Coins, className: "text-amber-400 border-amber-500/30 bg-amber-500/10" },
  sqlite: { icon: Database, className: "text-teal-400 border-teal-500/30 bg-teal-500/10" },
  zip: { icon: Package, className: "text-zinc-300 border-zinc-600/50 bg-zinc-500/10" },
  apk: { icon: Package, className: "text-zinc-300 border-zinc-600/50 bg-zinc-500/10" },
  jar: { icon: Package, className: "text-zinc-300 border-zinc-600/50 bg-zinc-500/10" },
  asar: { icon: PackageOpen, className: "text-zinc-300 border-zinc-600/50 bg-zinc-500/10" },
  gzip: { icon: Package, className: "text-zinc-300 border-zinc-600/50 bg-zinc-500/10" },
  tar: { icon: Package, className: "text-zinc-300 border-zinc-600/50 bg-zinc-500/10" },
  javascript: { icon: FileCode, className: "text-emerald-400 border-emerald-500/30 bg-emerald-500/10" },
  script: { icon: FileCode, className: "text-emerald-400 border-emerald-500/30 bg-emerald-500/10" },
  pcap: { icon: Network, className: "text-cyan-400 border-cyan-500/30 bg-cyan-500/10" },
  pcapng: { icon: Network, className: "text-cyan-400 border-cyan-500/30 bg-cyan-500/10" },
  dex: { icon: Smartphone, className: "text-orange-400 border-orange-500/30 bg-orange-500/10" },
  plist: { icon: ScrollText, className: "text-zinc-300 border-zinc-600/50 bg-zinc-500/10" },
  bplist: { icon: ScrollText, className: "text-zinc-300 border-zinc-600/50 bg-zinc-500/10" },
  pdf: { icon: FileText, className: "text-zinc-300 border-zinc-600/50 bg-zinc-500/10" },
  json: { icon: FileText, className: "text-zinc-300 border-zinc-600/50 bg-zinc-500/10" },
  text: { icon: FileText, className: "text-zinc-300 border-zinc-600/50 bg-zinc-500/10" },
  png: { icon: ImageIcon, className: "text-zinc-300 border-zinc-600/50 bg-zinc-500/10" },
  unknown: { icon: FileQuestion, className: "text-zinc-400 border-zinc-700 bg-zinc-800/60" },
};

export function FormatBadge({
  format,
  label,
  className,
}: {
  format: string | null | undefined;
  label?: string | null;
  className?: string;
}) {
  const entry = FORMAT_STYLES[format ?? "unknown"] ?? FORMAT_STYLES.unknown;
  const Icon = entry.icon;
  return (
    <Badge
      variant="outline"
      className={cn("gap-1 font-mono text-[11px] uppercase tracking-wide", entry.className, className)}
    >
      <Icon className="size-3" aria-hidden />
      {label ?? format ?? "unknown"}
    </Badge>
  );
}

const STATUS_STYLES: Record<string, { label: string; className: string; spin?: boolean; check?: boolean; fail?: boolean }> = {
  uploaded: { label: "Uploaded", className: "text-zinc-400 border-zinc-700 bg-zinc-800/60" },
  queued: { label: "Queued", className: "text-zinc-400 border-zinc-700 bg-zinc-800/60" },
  analyzing: { label: "Analyzing", className: "text-amber-400 border-amber-500/30 bg-amber-500/10", spin: true },
  running: { label: "Analyzing", className: "text-amber-400 border-amber-500/30 bg-amber-500/10", spin: true },
  analyzed: { label: "Analyzed", className: "text-emerald-400 border-emerald-500/30 bg-emerald-500/10", check: true },
  completed: { label: "Completed", className: "text-emerald-400 border-emerald-500/30 bg-emerald-500/10", check: true },
  failed: { label: "Failed", className: "text-rose-400 border-rose-500/30 bg-rose-500/10", fail: true },
};

export function StatusBadge({
  status,
  className,
}: {
  status: string | null | undefined;
  className?: string;
}) {
  const entry = STATUS_STYLES[status ?? "uploaded"] ?? STATUS_STYLES.uploaded;
  return (
    <Badge variant="outline" className={cn("gap-1.5", entry.className, className)}>
      {entry.spin && <Loader2 className="size-3 animate-spin" aria-hidden />}
      {entry.check && <Check className="size-3" aria-hidden />}
      {entry.fail && <span className="text-[10px] font-bold leading-none" aria-hidden>✕</span>}
      {entry.label}
    </Badge>
  );
}

const EVIDENCE_KIND_STYLES: Record<string, string> = {
  observed: "text-emerald-400 border-emerald-500/30 bg-emerald-500/10",
  derived: "text-amber-400 border-amber-500/30 bg-amber-500/10",
  inferred: "text-orange-400 border-orange-500/30 bg-orange-500/10",
  unknown: "text-rose-400 border-rose-500/30 bg-rose-500/10",
};

export function EvidenceKindBadge({
  kind,
  className,
}: {
  kind: string | null | undefined;
  className?: string;
}) {
  const key = (kind ?? "unknown").toLowerCase();
  return (
    <Badge
      variant="outline"
      className={cn(
        "font-mono text-[10px] uppercase tracking-widest",
        EVIDENCE_KIND_STYLES[key] ?? EVIDENCE_KIND_STYLES.unknown,
        className
      )}
    >
      {key}
    </Badge>
  );
}

export function ConfidenceBadge({ confidence }: { confidence: number | string | null | undefined }) {
  const label =
    typeof confidence === "number"
      ? `${Math.round(confidence * 100)}%`
      : confidence ?? "—";
  return (
    <span className="font-mono text-[11px] text-zinc-400">
      conf <span className="text-zinc-200">{label}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Layout / interaction primitives
// ---------------------------------------------------------------------------

export function SectionCard({
  title,
  description,
  icon: Icon,
  actions,
  children,
  className,
  contentClassName,
}: {
  title: string;
  description?: string;
  icon?: LucideIcon;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  return (
    <Card className={cn("border-zinc-800 bg-zinc-900/60", className)}>
      <CardHeader className="flex-row items-start justify-between space-y-0 pb-3">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold tracking-wide text-zinc-200">
            {Icon && <Icon className="size-4 text-emerald-400" aria-hidden />}
            {title}
          </CardTitle>
          {description && <CardDescription className="text-xs text-zinc-500">{description}</CardDescription>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </CardHeader>
      <CardContent className={contentClassName}>{children}</CardContent>
    </Card>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-zinc-800 bg-zinc-900/40 px-6 py-12 text-center",
        className
      )}
    >
      <div className="grid size-12 place-items-center rounded-lg border border-zinc-800 bg-zinc-900">
        <Icon className="size-6 text-zinc-500" aria-hidden />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-zinc-200">{title}</p>
        <p className="mx-auto max-w-md text-xs leading-relaxed text-zinc-500">{description}</p>
      </div>
      {action}
    </div>
  );
}

export function TooltipIconButton({
  label,
  children,
  className,
  ...props
}: React.ComponentProps<typeof Button> & { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={label}
          className={cn("size-8 text-zinc-400 hover:text-zinc-100", className)}
          {...props}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent className="border-zinc-700 bg-zinc-900 text-xs text-zinc-200">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

export function CopyButton({
  value,
  label,
  className,
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = React.useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toastError(new Error("Clipboard unavailable in this browser"), "Copy failed");
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={label ?? "Copy to clipboard"}
          onClick={onCopy}
          className={cn("size-7 text-zinc-500 hover:text-zinc-100", className)}
        >
          {copied ? <Check className="size-3.5 text-emerald-400" /> : <Copy className="size-3.5" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent className="border-zinc-700 bg-zinc-900 text-xs text-zinc-200">
        {copied ? "Copied" : label ?? "Copy"}
      </TooltipContent>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// 3D motion primitives (premium redesign, Task 3-b)
// ---------------------------------------------------------------------------

/**
 * True when the device can render pointer-driven tilt: fine pointer
 * (mouse/trackpad) and the user has not asked for reduced motion.
 * Re-evaluated live so e.g. a mouse being attached enables tilt.
 */
export function useTiltEnabled(disabled?: boolean): boolean {
  const [enabled, setEnabled] = React.useState(false);
  React.useEffect(() => {
    if (disabled) {
      setEnabled(false);
      return;
    }
    const fine = window.matchMedia("(pointer: fine)");
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setEnabled(fine.matches && !reduced.matches);
    update();
    fine.addEventListener?.("change", update);
    reduced.addEventListener?.("change", update);
    return () => {
      fine.removeEventListener?.("change", update);
      reduced.removeEventListener?.("change", update);
    };
  }, [disabled]);
  return enabled;
}

/**
 * TiltCard — pointer-reactive 3D tilt wrapper.
 *
 * rotateX/rotateY spring toward the cursor (max ±`maxTilt`deg) with a soft
 * shadow that shifts with the tilt. Children can pop out of the surface by
 * adding `[transform:translateZ(24px)]` (the card sets preserve-3d and its
 * own perspective). Falls back to a plain div for touch devices and
 * prefers-reduced-motion users.
 */
export function TiltCard({
  children,
  className,
  maxTilt = 6,
  glow = true,
  disabled,
}: {
  children: React.ReactNode;
  className?: string;
  maxTilt?: number;
  glow?: boolean;
  disabled?: boolean;
}) {
  const enabled = useTiltEnabled(disabled);
  const rotateX = useSpring(useMotionValue(0), { stiffness: 220, damping: 20, mass: 0.6 });
  const rotateY = useSpring(useMotionValue(0), { stiffness: 220, damping: 20, mass: 0.6 });

  // Shadow follows the tilt like a fixed overhead light.
  const shadowX = useTransform(rotateY, (v) => -v * 1.4);
  const shadowY = useTransform(rotateX, (v) => v * 1.4);
  const shadow = useMotionTemplate`${shadowX}px ${shadowY}px 34px -16px rgb(0 0 0 / 0.65)${
    glow ? ", 0 0 0 1px rgb(16 185 129 / 0)" : ""
  }`;

  const onMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!enabled) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width - 0.5;
    const py = (e.clientY - rect.top) / rect.height - 0.5;
    rotateY.set(px * maxTilt * 2);
    rotateX.set(-py * maxTilt * 2);
  };
  const reset = () => {
    rotateX.set(0);
    rotateY.set(0);
  };

  if (!enabled) {
    return (
      <div className={className} data-tilt="off">
        {children}
      </div>
    );
  }

  const style: MotionStyle = {
    rotateX,
    rotateY,
    transformPerspective: 900,
    transformStyle: "preserve-3d",
    boxShadow: shadow,
  };
  return (
    <motion.div
      data-tilt="on"
      className={cn("rea-tilt will-change-transform", className)}
      style={style}
      onMouseMove={onMouseMove}
      onMouseLeave={reset}
    >
      {children}
    </motion.div>
  );
}

const CUBE_FACES: { transform: (z: number) => string; label?: string }[] = [
  { transform: (z) => `translateZ(${z}px)`, label: "REA" },
  { transform: (z) => `rotateY(180deg) translateZ(${z}px)` },
  { transform: (z) => `rotateY(90deg) translateZ(${z}px)`, label: "MCP" },
  { transform: (z) => `rotateY(-90deg) translateZ(${z}px)`, label: "170" },
  { transform: (z) => `rotateX(90deg) translateZ(${z}px)` },
  { transform: (z) => `rotateX(-90deg) translateZ(${z}px)` },
];

/**
 * ReaCube — the floating REA core, pure CSS/HTML 3D cube.
 * Continuous Y rotation (~`spinDuration`s linear) with a slow X wobble.
 * Respects prefers-reduced-motion (renders a static tilted cube).
 */
export function ReaCube({
  size = 112,
  spinDuration = 24,
  className,
}: {
  size?: number;
  spinDuration?: number;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const half = size / 2;

  return (
    <div
      className={cn("rea-perspective", className)}
      style={{ width: size, height: size }}
      aria-hidden
    >
      <motion.div
        className="rea-preserve-3d relative size-full"
        initial={{ rotateX: 8, rotateY: -18 }}
        animate={
          reduced
            ? undefined
            : { rotateY: [-18, 342], rotateX: [8, -8, 8] }
        }
        transition={
          reduced
            ? undefined
            : {
                rotateY: {
                  duration: spinDuration,
                  ease: "linear",
                  repeat: Infinity,
                },
                rotateX: {
                  duration: Math.max(8, spinDuration / 2),
                  ease: "easeInOut",
                  repeat: Infinity,
                },
              }
        }
        style={{ transformStyle: "preserve-3d" }}
      >
        {CUBE_FACES.map((face, i) => (
          <div
            key={i}
            className="rea-cube-face"
            style={{ transform: face.transform(half) }}
          >
            {face.label && (
              <span
                className="font-mono font-bold tracking-[0.3em] text-emerald-400/80"
                style={{ fontSize: Math.max(10, size * 0.12) }}
              >
                {face.label}
              </span>
            )}
          </div>
        ))}
      </motion.div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

/** Terminal-flavoured markdown renderer for docs and assistant messages. */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("rea-markdown text-sm leading-relaxed text-zinc-300", className)}>
      <ReactMarkdown
        components={{
          h1: (props) => <h1 className="mt-4 mb-2 border-b border-zinc-800 pb-1 text-lg font-semibold text-zinc-100" {...props} />,
          h2: (props) => <h2 className="mt-4 mb-2 text-base font-semibold text-zinc-100" {...props} />,
          h3: (props) => <h3 className="mt-3 mb-1 text-sm font-semibold text-emerald-400" {...props} />,
          p: (props) => <p className="mb-2 last:mb-0" {...props} />,
          a: (props) => <a className="text-emerald-400 underline underline-offset-2" target="_blank" rel="noreferrer" {...props} />,
          ul: (props) => <ul className="mb-2 list-disc space-y-1 pl-5" {...props} />,
          ol: (props) => <ol className="mb-2 list-decimal space-y-1 pl-5" {...props} />,
          li: (props) => <li className="text-zinc-300" {...props} />,
          strong: (props) => <strong className="font-semibold text-zinc-100" {...props} />,
          blockquote: (props) => <blockquote className="mb-2 border-l-2 border-emerald-500/40 pl-3 text-zinc-400" {...props} />,
          code: ({ className: cls, children: kids, ...rest }) => {
            const isBlock = /language-/.test(cls ?? "");
            if (isBlock) {
              return (
                <code
                  className={cn("block overflow-x-auto rounded-md border border-zinc-800 bg-zinc-950 p-3 font-mono text-xs text-zinc-200 rea-scroll", cls)}
                  {...rest}
                >
                  {kids}
                </code>
              );
            }
            return (
              <code className="rounded bg-zinc-800 px-1 py-0.5 font-mono text-[12px] text-emerald-300" {...rest}>
                {kids}
              </code>
            );
          },
          pre: (props) => <pre className="mb-2" {...props} />,
          table: (props) => (
            <div className="rea-scroll mb-2 max-h-80 overflow-auto rounded-md border border-zinc-800">
              <table className="w-full border-collapse text-xs" {...props} />
            </div>
          ),
          th: (props) => <th className="border-b border-zinc-800 bg-zinc-900 px-2 py-1.5 text-left font-semibold text-zinc-200" {...props} />,
          td: (props) => <td className="border-b border-zinc-800/60 px-2 py-1.5 align-top" {...props} />,
          hr: () => <hr className="my-3 border-zinc-800" />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
