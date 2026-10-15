import { db } from "./db";
import { normalize } from "path";

/**
 * Security utilities: rate limiting, audit logging, input guards.
 */

// ---------------------------------------------------------------------------
// In-memory sliding-window rate limiter (per key).
// ---------------------------------------------------------------------------

interface Bucket {
  timestamps: number[];
}

const buckets = new Map<string, Bucket>();
let lastSweep = Date.now();

function sweep(now: number) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    bucket.timestamps = bucket.timestamps.filter(
      (t) => now - t < 10 * 60_000
    );
    if (bucket.timestamps.length === 0) buckets.delete(key);
  }
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number
): RateLimitResult {
  const now = Date.now();
  sweep(now);
  const bucket = buckets.get(key) ?? { timestamps: [] };
  bucket.timestamps = bucket.timestamps.filter((t) => now - t < windowMs);
  if (bucket.timestamps.length >= limit) {
    const oldest = bucket.timestamps[0];
    buckets.set(key, bucket);
    return {
      allowed: false,
      remaining: 0,
      retryAfterSec: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)),
    };
  }
  bucket.timestamps.push(now);
  buckets.set(key, bucket);
  return { allowed: true, remaining: limit - bucket.timestamps.length, retryAfterSec: 0 };
}

export function clientIp(req: Request): string {
  // Behind Caddy both headers are overwritten with the real remote host.
  // Prefer x-real-ip; if absent, take the LAST XFF hop (the hop added by our
  // own proxy) rather than the first (client-spoofable) one.
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const hops = fwd.split(",").map((h) => h.trim()).filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }
  return "local";
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export async function audit(
  action: string,
  opts: {
    userId?: string | null;
    detail?: string;
    ip?: string;
    severity?: "info" | "warn" | "critical";
  } = {}
) {
  try {
    await db.auditLog.create({
      data: {
        action,
        userId: opts.userId ?? null,
        detail: opts.detail?.slice(0, 2000),
        ip: opts.ip,
        severity: opts.severity ?? "info",
      },
    });
  } catch {
    // audit failures must never break the request path
  }
}

// ---------------------------------------------------------------------------
// Input guards
// ---------------------------------------------------------------------------

/** Sanitize a filename for display/storage: strip path components & control chars. */
export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() || "file";
  const cleaned = base.replace(/[\x00-\x1f\x7f]/g, "").trim();
  return (cleaned || "file").slice(0, 180);
}

/** Validate a cuid-like id to prevent injection through path/DB misuse. */
export function isSafeId(id: string): boolean {
  return typeof id === "string" && /^[a-z0-9]{20,40}$/i.test(id);
}

/** Ensure a resolved path stays inside an allowed root (no traversal). */
export function isPathInside(child: string, root: string): boolean {
  const c = child.startsWith("/") ? child : `${process.cwd()}/${child}`;
  const r = root.startsWith("/") ? root : `${process.cwd()}/${root}`;
  const cn = normalize(c);
  const rn = normalize(r);
  return cn === rn || cn.startsWith(rn + "/");
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB
export const ANALYSIS_TIMEOUT_MS = 120_000; // per AREA tool call
export const CHAT_TOOL_TIMEOUT_MS = 60_000;
export const MAX_CHAT_ITERATIONS = 12;
export const MAX_OUTPUT_BYTES = 12 * 1024 * 1024; // AREA output cap
