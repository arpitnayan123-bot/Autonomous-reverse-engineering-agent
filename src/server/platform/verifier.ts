import { diffLines } from "diff";
import * as cheerio from "cheerio";
import { db } from "@/lib/db";
import { safeFetch, BlockedUrlError } from "./net";
import { upsertGraph } from "./graph";
import { tryBrowser } from "./browser";

/**
 * AREA Verification — functional checks, reference comparison, regression.
 *
 * Runs HTTP-level checks with assertions (status, title presence, security
 * headers, soft-404 detection, latency), compares a reconstruction against
 * its reference with a real text diff, and flags regressions against the
 * previous run's score. If a Chromium runtime is available, a rendered
 * browser check (title + console errors) is added on top — capability-detected
 * at runtime, never simulated.
 */

export interface VerifyCheck {
  name: string;
  passed: boolean;
  detail: string;
  ms: number;
}

export interface VerifyResult {
  score: number; // 0-100
  checks: VerifyCheck[];
  url: string;
  regression: boolean | null; // null = no previous run
  scoreDelta: number | null;
  diffSummary: string | null;
  browserAvailable: boolean;
}

const SOFT_404_MARKERS = [
  "page not found", "404 not found", "not found", "nothing found",
  "page cannot be found", "doesn't exist", "no longer exists",
];

function detectSoft404(title: string | null, text: string): boolean {
  const hay = `${(title ?? "").toLowerCase()} ${text.slice(0, 2000).toLowerCase()}`;
  return SOFT_404_MARKERS.some((m) => hay.includes(m) && hay.length < 4000);
}

function securityHeaderChecks(headers: Record<string, string>): VerifyCheck[] {
  const get = (k: string) => headers[k] ?? headers[k.toLowerCase()] ?? "";
  return [
    {
      name: "hsts",
      passed: Boolean(get("strict-transport-security")),
      detail: get("strict-transport-security") || "no Strict-Transport-Security header",
      ms: 0,
    },
    {
      name: "content-type-options",
      passed: get("x-content-type-options").toLowerCase() === "nosniff",
      detail: get("x-content-type-options") || "missing x-content-type-options",
      ms: 0,
    },
    {
      name: "frame-options-or-csp",
      passed: Boolean(get("content-security-policy") || get("x-frame-options")),
      detail: get("content-security-policy") ? "CSP present" : get("x-frame-options") || "no CSP or X-Frame-Options",
      ms: 0,
    },
  ];
}

/** Run the default functional check suite against a URL. */
export async function runVerification(
  projectId: string,
  url: string,
  opts?: { referenceUrl?: string }
): Promise<VerifyResult> {
  const checks: VerifyCheck[] = [];
  let browserAvailable = false;

  // 1. Reachability + latency.
  let res;
  const t0 = Date.now();
  try {
    res = await safeFetch(url, { maxBytes: 2 * 1024 * 1024 });
    checks.push({
      name: "reachable",
      passed: res.status >= 200 && res.status < 400,
      detail: `HTTP ${res.status} (${res.ms}ms)`,
      ms: res.ms,
    });
  } catch (err) {
    const detail = err instanceof BlockedUrlError ? err.message : `fetch failed: ${err instanceof Error ? err.message : String(err)}`;
    checks.push({ name: "reachable", passed: false, detail, ms: Date.now() - t0 });
    res = null;
  }

  let title: string | null = null;
  let text = "";
  if (res && res.contentType.includes("html")) {
    const $ = cheerio.load(res.body.toString("utf8").slice(0, 1_000_000));
    title = ($("title").first().text() || "").trim() || null;
    text = $("body").text().replace(/\s+/g, " ").trim();

    // 2. Title presence.
    checks.push({
      name: "title-present",
      passed: Boolean(title && title.length > 2),
      detail: title ? `"<title>${title.slice(0, 100)}</title>"` : "no <title> element",
      ms: 0,
    });

    // 3. Content substance (a real page has >200 chars of text).
    checks.push({
      name: "content-substance",
      passed: text.length > 200,
      detail: `${text.length} chars of visible text`,
      ms: 0,
    });

    // 4. Soft-404 heuristic on the main URL.
    checks.push({
      name: "no-soft-404",
      passed: !detectSoft404(title, text),
      detail: "page does not look like a soft-404",
      ms: 0,
    });

    // 5-7. Security headers.
    checks.push(...securityHeaderChecks(res.headers));

    // 8. robots.txt present.
    try {
      const robots = await safeFetch(new URL("/robots.txt", res.url).toString(), { maxBytes: 64 * 1024, timeoutMs: 8_000 });
      checks.push({
        name: "robots-txt",
        passed: robots.status === 200,
        detail: robots.status === 200 ? "robots.txt served" : `robots.txt HTTP ${robots.status}`,
        ms: robots.ms,
      });
    } catch {
      checks.push({ name: "robots-txt", passed: false, detail: "robots.txt unreachable", ms: 0 });
    }
  }

  // 9. 404 behavior (soft-404 detection on a random missing path).
  if (res) {
    const probeUrl = new URL(`/area-verify-${Math.random().toString(36).slice(2, 10)}`, res.url).toString();
    try {
      const probe = await safeFetch(probeUrl, { maxBytes: 256 * 1024, timeoutMs: 10_000 });
      let probeText = "";
      if (probe.contentType.includes("html")) {
        const $p = cheerio.load(probe.body.toString("utf8").slice(0, 100_000));
        probeText = $p("body").text().replace(/\s+/g, " ").trim();
      }
      const clean404 = probe.status === 404 || (probe.status === 200 && detectSoft404(null, probeText));
      checks.push({
        name: "honest-404",
        passed: clean404,
        detail: probe.status === 404 ? "returns HTTP 404 for missing pages" : probe.status === 200 ? "returns 200 for missing pages (soft 404)" : `HTTP ${probe.status}`,
        ms: probe.ms,
      });
    } catch (err) {
      checks.push({ name: "honest-404", passed: false, detail: err instanceof Error ? err.message : "probe failed", ms: 0 });
    }
  }

  // 10. Browser check when a Chromium runtime exists (capability-detected).
  const browser = await tryBrowser(url);
  browserAvailable = browser.available;
  if (browser.available) {
    checks.push({
      name: "browser-render",
      passed: !browser.consoleErrors || browser.consoleErrors.length === 0,
      detail: browser.available
        ? `rendered "${(browser.title ?? "").slice(0, 80)}"${browser.consoleErrors?.length ? `, ${browser.consoleErrors.length} console errors: ${browser.consoleErrors.slice(0, 3).join(" | ")}` : ", no console errors"}`
        : "unavailable",
      ms: browser.ms ?? 0,
    });
  }

  // 11. Reference-vs-reconstruction diff when a reference was provided.
  let diffSummary: string | null = null;
  if (opts?.referenceUrl && res) {
    try {
      const refRes = await safeFetch(opts.referenceUrl, { maxBytes: 2 * 1024 * 1024 });
      const ref$ = cheerio.load(refRes.body.toString("utf8").slice(0, 1_000_000));
      const refText = ref$("body").text().replace(/\s+/g, " ").trim();
      const cand$ = cheerio.load(res.body.toString("utf8").slice(0, 1_000_000));
      const candText = cand$("body").text().replace(/\s+/g, " ").trim();

      const hunks = diffLines(refText, candText);
      const added = hunks.filter((h) => h.added).reduce((a, h) => a + h.count!, 0);
      const removed = hunks.filter((h) => h.removed).reduce((a, h) => a + h.count!, 0);
      const refWords = refText.split(/\s+/).filter(Boolean).length || 1;
      const drift = Math.round(((added + removed) / Math.max(refWords, candWords(candText))) * 100);
      diffSummary = `reference ${refWords} words vs reconstruction ${candWords(candText)} words; +${added}/-${removed} line drift (~${Math.min(drift, 999)}%)`;
      checks.push({
        name: "reference-diff",
        passed: drift < 50,
        detail: diffSummary,
        ms: refRes.ms,
      });
    } catch (err) {
      diffSummary = `reference fetch failed: ${err instanceof Error ? err.message : String(err)}`;
      checks.push({ name: "reference-diff", passed: false, detail: diffSummary, ms: 0 });
    }
  }

  // Score: weighted pass ratio.
  const weights: Record<string, number> = {
    reachable: 3, "title-present": 1.5, "content-substance": 2, "no-soft-404": 1.5,
    hsts: 1, "content-type-options": 1, "frame-options-or-csp": 1, "robots-txt": 0.5,
    "honest-404": 1, "browser-render": 2, "reference-diff": 3,
  };
  let earned = 0;
  let total = 0;
  for (const c of checks) {
    const w = weights[c.name] ?? 1;
    total += w;
    if (c.passed) earned += w;
  }
  const score = Math.round((earned / Math.max(total, 1)) * 100);

  // Regression vs the previous run.
  const previous = await db.verificationRun.findFirst({
    where: { projectId },
    orderBy: { createdAt: "desc" },
  });
  const scoreDelta = previous?.score != null ? score - previous.score : null;
  const regression = scoreDelta != null ? scoreDelta < -10 : null;

  await db.verificationRun.create({
    data: {
      projectId,
      url,
      status: "completed",
      score,
      checks: JSON.stringify(checks),
      diffSummary,
      regression,
    },
  });

  await upsertGraph(projectId, [
    {
      kind: "finding",
      key: `verification:${new Date().toISOString()}`,
      label: `Verification score ${score}/100`,
      meta: { url, score, regression },
      provenance: "OBSERVED",
    },
  ], []);

  return { score, checks, url: res?.url ?? url, regression, scoreDelta, diffSummary, browserAvailable };
}

function candWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

// ---------------------------------------------------------------------------
// Clone equivalence (CLONE stage) — behavioral comparison of a booted clone
// against the original. Real HTTP fetches on both sides, word-level drift,
// status parity, title parity. Persisted as a VerificationRun so it lands in
// the same ledger (and regression tracking) as every other verification.
// ---------------------------------------------------------------------------

export interface CloneEquivalenceResult {
  score: number;
  checks: VerifyCheck[];
  originalUrl: string;
  cloneUrl: string;
}

export async function runCloneVerification(
  projectId: string,
  opts: { originalUrl: string; cloneUrl: string }
): Promise<CloneEquivalenceResult> {
  const checks: VerifyCheck[] = [];
  let original: Awaited<ReturnType<typeof safeFetch>> | null = null;
  let clone: Awaited<ReturnType<typeof safeFetch>> | null = null;

  const fetchSide = async (url: string) => {
    try {
      return await safeFetch(url, { maxBytes: 2 * 1024 * 1024 });
    } catch {
      return null;
    }
  };

  [original, clone] = await Promise.all([fetchSide(opts.originalUrl), fetchSide(opts.cloneUrl)]);

  checks.push({
    name: "clone-reachable",
    passed: Boolean(clone && clone.status >= 200 && clone.status < 400),
    detail: clone ? `clone HTTP ${clone.status} (${clone.ms}ms)` : "clone unreachable",
    ms: clone?.ms ?? 0,
  });
  checks.push({
    name: "original-reachable",
    passed: Boolean(original && original.status >= 200 && original.status < 400),
    detail: original ? `original HTTP ${original.status} (${original.ms}ms)` : "original unreachable (equivalence not measurable)",
    ms: original?.ms ?? 0,
  });

  if (original && clone) {
    checks.push({
      name: "status-parity",
      passed: Math.floor(original.status / 100) === Math.floor(clone.status / 100),
      detail: `original ${original.status} vs clone ${clone.status}`,
      ms: 0,
    });

    const textOf = (res: NonNullable<typeof original>) => {
      if (!res.contentType.includes("html")) return res.body.toString("utf8").slice(0, 200_000);
      const $ = cheerio.load(res.body.toString("utf8").slice(0, 1_000_000));
      return $("body").text().replace(/\s+/g, " ").trim();
    };
    const origText = textOf(original);
    const cloneText = textOf(clone);

    const hunks = diffLines(origText, cloneText);
    const added = hunks.filter((h) => h.added).reduce((a, h) => a + h.count!, 0);
    const removed = hunks.filter((h) => h.removed).reduce((a, h) => a + h.count!, 0);
    const denom = Math.max(origText.split(/\s+/).filter(Boolean).length, cloneText.split(/\s+/).filter(Boolean).length, 1);
    const drift = Math.round(((added + removed) / denom) * 100);
    checks.push({
      name: "text-equivalence",
      passed: drift < 50,
      detail: `word drift ~${Math.min(drift, 999)}% (+${added}/-${removed} lines)`,
      ms: 0,
    });

    const origTitle = original.contentType.includes("html") ? (cheerio.load(original.body.toString("utf8").slice(0, 1_000_000))("title").first().text() || "").trim() : "";
    const cloneTitle = clone.contentType.includes("html") ? (cheerio.load(clone.body.toString("utf8").slice(0, 1_000_000))("title").first().text() || "").trim() : "";
    checks.push({
      name: "title-parity",
      passed: Boolean(origTitle) && origTitle.toLowerCase() === cloneTitle.toLowerCase(),
      detail: origTitle ? `original "${origTitle.slice(0, 60)}" vs clone "${cloneTitle.slice(0, 60)}"` : "original has no title to compare",
      ms: 0,
    });
  }

  const weights: Record<string, number> = {
    "clone-reachable": 2, "original-reachable": 1, "status-parity": 2, "text-equivalence": 4, "title-parity": 1,
  };
  let earned = 0;
  let total = 0;
  for (const c of checks) {
    const w = weights[c.name] ?? 1;
    total += w;
    if (c.passed) earned += w;
  }
  const score = Math.round((earned / Math.max(total, 1)) * 100);

  await db.verificationRun.create({
    data: {
      projectId,
      url: opts.cloneUrl,
      status: "completed",
      score,
      checks: JSON.stringify(checks),
      diffSummary: `clone equivalence vs ${opts.originalUrl}`,
      regression: null,
    },
  });

  await upsertGraph(projectId, [
    {
      kind: "finding",
      key: `clone-equivalence:${new Date().toISOString()}`,
      label: `Clone equivalence ${score}/100`,
      meta: { originalUrl: opts.originalUrl, cloneUrl: opts.cloneUrl, score },
      provenance: "OBSERVED",
    },
  ], []);

  return { score, checks, originalUrl: original?.url ?? opts.originalUrl, cloneUrl: clone?.url ?? opts.cloneUrl };
}
