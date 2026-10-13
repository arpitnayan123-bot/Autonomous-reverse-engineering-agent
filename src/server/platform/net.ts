import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * SSRF-safe fetch layer for user-supplied URLs.
 *
 * The Explorer and Verifier fetch URLs the USER typed. A hostile or careless
 * URL must never let the server reach internal infrastructure: cloud metadata
 * endpoints, loopback services, the platform's own port, or private network
 * ranges. Every outbound fetch therefore passes through this guard:
 *
 *  1. scheme allowlist (http/https only)
 *  2. hostname resolution with literal-IP checks BEFORE connecting
 *  3. the resolved IP is re-validated after every redirect hop
 *  4. response size caps, timeouts, and a bounded redirect chain
 *
 * Redirect handling is manual (redirect: "manual") so each Location hop is
 * re-guarded — fetch's automatic redirect following would bypass validation.
 */

export class BlockedUrlError extends Error {
  constructor(reason: string) {
    super(`URL blocked by SSRF guard: ${reason}`);
    this.name = "BlockedUrlError";
  }
}

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);
const MAX_REDIRECTS = 4;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 3 * 1024 * 1024; // 3 MB per response

/** Hosts that must never be fetched even if they resolve publicly. */
const BLOCKED_HOSTNAMES = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
]);

function ipIsPrivate(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::" || lower === "::0") return true;
    if (lower.startsWith("fe80")) return true; // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA
    if (lower.startsWith("::ffff:")) {
      // IPv4-mapped — validate the embedded v4 address.
      return ipIsPrivate(lower.slice(7));
    }
  }
  return false;
}

/**
 * Validate a URL string and resolve every DNS answer through the private-IP
 * guard. Returns the validated URL object. Throws BlockedUrlError.
 */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedUrlError("unparseable URL");
  }
  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    throw new BlockedUrlError(`scheme ${url.protocol} not allowed`);
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTNAMES.has(host)) {
    throw new BlockedUrlError("blocked hostname");
  }
  // Credentials in the URL are never legitimate for crawling targets.
  if (url.username || url.password) {
    throw new BlockedUrlError("embedded credentials");
  }

  // Literal IPs are checked directly; names are resolved and every answer
  // (A + AAAA) must be public — a single private answer blocks the host.
  if (isIP(host)) {
    if (ipIsPrivate(host)) throw new BlockedUrlError(`private address ${host}`);
    return url;
  }
  let answers: { address: string }[];
  try {
    answers = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new BlockedUrlError("DNS resolution failed");
  }
  if (answers.length === 0) throw new BlockedUrlError("no DNS answers");
  for (const a of answers) {
    if (ipIsPrivate(a.address)) {
      throw new BlockedUrlError(`resolves to private address ${a.address}`);
    }
  }
  return url;
}

export interface SafeFetchResult {
  url: string; // final URL after redirects
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  contentType: string;
  ms: number;
}

/**
 * SSRF-guarded fetch with manual redirect handling, timeout and size cap.
 * The response body is buffered (capped) — callers parse the buffer.
 */
export async function safeFetch(
  rawUrl: string,
  opts?: { timeoutMs?: number; maxBytes?: number; headers?: Record<string, string> }
): Promise<SafeFetchResult> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
  let currentUrl = await assertPublicUrl(rawUrl);

  const started = Date.now();
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(currentUrl, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          // Polite, honest client identification.
          "user-agent": "REA-Platform/1.0 (+reverse-engineering research crawler)",
          "accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
          "accept-language": "en;q=0.9",
          ...opts?.headers,
        },
      });

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) {
          // 3xx without Location — treat as a terminal status.
          return {
            url: currentUrl.toString(),
            status: res.status,
            headers: Object.fromEntries(res.headers.entries()),
            body: Buffer.alloc(0),
            contentType: res.headers.get("content-type") ?? "",
            ms: Date.now() - started,
          };
        }
        try {
          res.body?.cancel();
        } catch {
          /* drain */
        }
        const next = new URL(loc, currentUrl);
        // Every redirect target is re-validated (scheme + DNS + private IP).
        currentUrl = await assertPublicUrl(next.toString());
        continue;
      }

      const headers = Object.fromEntries(res.headers.entries());
      const contentType = res.headers.get("content-type") ?? "";
      const declared = Number(res.headers.get("content-length") ?? "0");
      if (declared > maxBytes) {
        try {
          res.body?.cancel();
        } catch {
          /* drain */
        }
        throw new BlockedUrlError(
          `response too large (${declared} bytes declared)`
        );
      }
      const chunks: Buffer[] = [];
      let received = 0;
      const reader = res.body?.getReader();
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.byteLength;
          if (received > maxBytes) {
            try {
              await reader.cancel();
            } catch {
              /* drain */
            }
            break;
          }
          chunks.push(Buffer.from(value));
        }
      }
      return {
        url: currentUrl.toString(),
        status: res.status,
        headers,
        body: Buffer.concat(chunks),
        contentType,
        ms: Date.now() - started,
      };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new BlockedUrlError(`more than ${MAX_REDIRECTS} redirects`);
}

/** Build a safe fetch client with extra headers (used by connectors). */
export function safeFetcher(headers: Record<string, string>) {
  return (url: string, opts?: { timeoutMs?: number; maxBytes?: number }) =>
    safeFetch(url, { ...opts, headers });
}
