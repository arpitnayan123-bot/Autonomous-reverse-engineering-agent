#!/usr/bin/env bun
/**
 * REA Explorer regression — proves the Explorer EXECUTES real web analysis
 * (registry routing + real network fetch + real extraction) instead of
 * returning conceptual guidance, and that its safety restrictions hold.
 *
 * Live network (public, ICANN/IANA-run documentation hosts — no third-party
 * impact):
 *   - https://example.com  — the mandated safe live test. NOTE: its real
 *     markup is title-only on the current Cloudflare-served variant (no <h1>,
 *     no links), so assertions cover exactly what is truly served.
 *   - https://www.iana.org — stable rich page (h1/h2s, dozens of links,
 *     fingerprintable headers) proving headings/links/tech extraction.
 *
 * Safety cases never rely on fetching blocked targets succeeding.
 *
 * Run:  bun scripts/regression-explorer.ts
 * Exit: 0 = all checks passed, 1 = at least one failure (printed).
 */
import { AGENT_TOOLS, executeAgentTool } from "@/server/agent/tools";
import type { AgentToolContext } from "@/server/agent/tools";
import { probeUrl, crawlBounded, type ProbeResult } from "@/server/platform/explorer";
import { BlockedUrlError } from "@/server/platform/net";
import type { Target } from "@prisma/client";

let failures = 0;

function check(name: string, ok: boolean, detail?: string): void {
  const mark = ok ? "PASS" : "FAIL";
  console.log(`${mark}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// explore_url never touches the target — the context is a formality here.
const stubCtx: AgentToolContext = { target: {} as Target, userId: "regression" };

async function expectBlocked(url: string, label: string): Promise<void> {
  try {
    await probeUrl(url);
    check(`SSRF guard blocks ${label}`, false, `probeUrl unexpectedly succeeded for ${url}`);
  } catch (err) {
    check(
      `SSRF guard blocks ${label}`,
      err instanceof BlockedUrlError,
      err instanceof Error ? err.message.slice(0, 90) : String(err)
    );
  }
}

async function main(): Promise<void> {
  console.log("REA Explorer regression — live example.com + iana.org + safety guards\n");

  // 1. Registration: the chat agent registry exposes the Explorer.
  check("registry contains explore_url", AGENT_TOOLS.some((t) => t.name === "explore_url"));

  // 2. AGENT-LAYER EXECUTION on the mandated safe live URL.
  const out = await executeAgentTool("explore_url", { url: "https://example.com" }, stubCtx);
  check(
    "agent tool executes a REAL fetch of https://example.com",
    out.includes("status: 200") && out.includes("final URL: https://example.com") && out.includes("Example Domain"),
    `head: ${out.slice(0, 110).replace(/\n/g, " | ")}`
  );
  check(
    "output is OBSERVED evidence, not conceptual guidance",
    /here's how you (would|could)|I cannot analyze|as an ai language|I'm unable to browse/i.test(out) === false
  );
  check(
    "real served text grounded in the excerpt (title-only variant has no h1/links — asserted honestly)",
    out.includes("## Headings") && out.includes("## Technology fingerprints") && /This domain is for use in/i.test(out)
  );

  // 3. STRUCTURED probe of example.com — exactly what the wire served.
  const ex = await probeUrl("https://example.com", { includeText: true });
  check("example.com finalUrl stays https://example.com", ex.finalUrl.startsWith("https://example.com"), ex.finalUrl);
  check("example.com title === 'Example Domain'", ex.title === "Example Domain", ex.title ?? "(null)");
  check("example.com status/content-type/timing observed", ex.status === 200 && ex.contentType.includes("text/html") && typeof ex.ms === "number", `${ex.status}, ${ex.contentType}, ${ex.ms}ms`);
  check("example.com contentHash is sha256 hex", /^[0-9a-f]{64}$/.test(ex.contentHash));
  check(
    "example.com served markup honestly has no h1/links (extraction matches reality)",
    ex.headings.h1.length === 0 && ex.links.length === 0,
    `h1=${ex.headings.h1.length}, links=${ex.links.length}`
  );

  // 4. RICH EXTRACTION PROOF on a stable structured page.
  const iana = await probeUrl("https://www.iana.org/", { includeText: false });
  check("iana.org title === 'Internet Assigned Numbers Authority'", iana.title === "Internet Assigned Numbers Authority", iana.title ?? "(null)");
  check("iana.org h1 extracted", iana.headings.h1.includes("Internet Assigned Numbers Authority"), JSON.stringify(iana.headings.h1));
  check("iana.org h2 sections extracted (>=3)", iana.headings.h2.length >= 3, JSON.stringify(iana.headings.h2));
  check("iana.org links captured (>=10)", iana.links.length >= 10, `${iana.links.length} links`);
  check("iana.org tech fingerprinted from headers", iana.tech.includes("cdn:cloudflare"), JSON.stringify(iana.tech));

  // 5. AGENT-LAYER RICH OUTPUT: links table + headings rendered for the LLM.
  const ianaOut = await executeAgentTool("explore_url", { url: "https://www.iana.org/", include_text: false }, stubCtx);
  check(
    "agent output renders headings + links table",
    ianaOut.includes("- h1: Internet Assigned Numbers Authority") && ianaOut.includes("| /about |") && ianaOut.includes("## Links (")
  );
  check(
    "include_text:false omits the excerpt section",
    !ianaOut.includes("## Text excerpt")
  );

  // 6. SAFETY: private/internal/metadata/scheme restrictions hold.
  await expectBlocked("http://127.0.0.1:3000/", "loopback");
  await expectBlocked("http://169.254.169.254/latest/meta-data/", "cloud metadata (link-local)");
  await expectBlocked("ftp://example.com/", "non-http(s) scheme");
  // IPv4-embedded IPv6 spellings — URL parsing canonicalizes dotted mapped
  // form to hex, so all of these must decode to a refused private address.
  await expectBlocked("http://[::ffff:127.0.0.1]:3000/", "IPv4-mapped loopback (dotted)");
  await expectBlocked("http://[::ffff:7f00:1]:3000/", "IPv4-mapped loopback (URL-canonical hex)");
  await expectBlocked("http://[0:0:0:0:0:ffff:10.0.0.5]:3000/", "IPv4-mapped private (full form)");
  await expectBlocked("http://[::10.0.0.5]:3000/", "deprecated IPv4-compatible private");

  // 7. ERROR REPORTING: unreachable domain yields a clear, honest failure.
  const badOut = await executeAgentTool(
    "explore_url",
    { url: "https://rea-regression-nonexistent.invalid" },
    stubCtx
  );
  check(
    "unresolvable domain → clear DNS error (no fabrication)",
    badOut.startsWith("Error:") && /dns/i.test(badOut),
    badOut.slice(0, 110)
  );

  // 8. ROUTING intact: unknown tools still fail with the registry list.
  const unknownOut = await executeAgentTool("crawl_website", { url: "https://example.com" }, stubCtx);
  check(
    "unknown tool lists the registry (routing intact)",
    unknownOut.startsWith("Error: unknown tool") && unknownOut.includes("explore_url")
  );

  // 9. BOUNDED CRAWL (crawlBounded) — deterministic synthetic graph via the
  // fetchPage seam (hosted on a genuinely resolvable host, because the
  // fail-fast start guard does a real DNS lookup by design), then the real
  // network on https://example.com.
  const FAKE = "https://example.com";

  /** Bounded retry for transient sandbox-DNS failures on the START guard;
   *  the guard itself stays fail-closed — we only retry real DNS hiccups. */
  async function crawlRetry(url: string, opts: Parameters<typeof crawlBounded>[1]): Promise<Awaited<ReturnType<typeof crawlBounded>>> {
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await crawlBounded(url, opts);
      } catch (err) {
        lastErr = err;
        if (!(err instanceof BlockedUrlError && /dns/i.test(err.message))) throw err;
        console.log(`… attempt ${attempt} hit transient DNS failure, retrying`);
        await new Promise((r) => setTimeout(r, 1_500));
      }
    }
    throw lastErr;
  }
  function mkProbe(url: string, title: string | null, hrefs: string[]): ProbeResult {
    return {
      requestUrl: url,
      finalUrl: url,
      status: 200,
      ms: 1,
      contentType: "text/html",
      title,
      description: null,
      headings: { h1: [], h2: [], h3: [] },
      links: hrefs.map((h) => ({ href: h, text: h })),
      tech: [],
      textExcerpt: null,
      contentHash: "0".repeat(64),
    };
  }
  const graph: Record<string, ProbeResult> = {
    [`${FAKE}/a`]: mkProbe(`${FAKE}/a`, "A", ["/b", "/a", "/c", "https://other.test/x", "/logo.png"]),
    [`${FAKE}/b`]: mkProbe(`${FAKE}/b`, "B", ["/c", "/d"]),
    [`${FAKE}/c`]: mkProbe(`${FAKE}/c`, "C", ["/d"]),
    [`${FAKE}/d`]: mkProbe(`${FAKE}/d`, "D", ["/e"]),
    [`${FAKE}/e`]: mkProbe(`${FAKE}/e`, "E", []),
  };
  const fakeFetch = (url: string): Promise<ProbeResult> => {
    const hit = graph[url];
    if (!hit) return Promise.reject(new Error(`404 ${url}`));
    return Promise.resolve(hit);
  };

  // 9a. successful crawl + duplicate-link handling + same-origin filter.
  const t1 = await crawlRetry(`${FAKE}/a`, {
    maxPages: 10,
    maxDepth: 3,
    respectRobots: false,
    fetchPage: fakeFetch,
  });
  check(
    "crawl visits the whole same-origin graph breadth-first",
    t1.visited.join(",") === ["/a", "/b", "/c", "/d", "/e"].map((p) => FAKE + p).join(",") &&
      t1.pages.every((p) => p.status === 200 && p.title),
    `visited: ${t1.visited.join(" → ")}`
  );
  check(
    "crawl counts duplicate links via the visited set (self + re-discovered)",
    t1.duplicatesSkipped === 3,
    `duplicatesSkipped=${t1.duplicatesSkipped}`
  );
  check(
    "crawl stays on the start origin and skips asset links",
    !t1.visited.some((u) => u.includes("other.test")) && !t1.visited.some((u) => u.endsWith(".png")),
    `origin=${t1.origin}`
  );

  // 9b. depth limit: maxDepth 1 must stop after depth-1 pages.
  const t2 = await crawlRetry(`${FAKE}/a`, {
    maxPages: 10,
    maxDepth: 1,
    respectRobots: false,
    fetchPage: fakeFetch,
  });
  check(
    "depth limit holds (maxDepth 1 → entry + depth-1 pages only)",
    t2.visited.join(",") === ["/a", "/b", "/c"].map((p) => FAKE + p).join(",") &&
      !t2.visited.includes(`${FAKE}/d`),
    `visited: ${t2.visited.join(" → ")}`
  );

  // 9c. page budget: attempts stop at maxPages, remainder reported as queued.
  const t3 = await crawlRetry(`${FAKE}/a`, {
    maxPages: 2,
    maxDepth: 3,
    respectRobots: false,
    fetchPage: fakeFetch,
  });
  check(
    "page limit holds (2 fetched, remainder queued)",
    t3.pages.length === 2 && t3.queued === 2 && t3.limits.maxPages === 2,
    `pages=${t3.pages.length} queued=${t3.queued}`
  );

  // 9d. per-page error reporting keeps the crawl going.
  const errGraph: Record<string, ProbeResult> = {
    [`${FAKE}/a`]: mkProbe(`${FAKE}/a`, "A", ["/bad"]),
  };
  const t4 = await crawlRetry(`${FAKE}/a`, {
    maxPages: 5,
    maxDepth: 1,
    respectRobots: false,
    fetchPage: (url) =>
      url === `${FAKE}/bad`
        ? Promise.reject(new Error("connection refused"))
        : Promise.resolve(errGraph[url]!),
  });
  check(
    "page errors are recorded with status 0 and the crawl continues",
    t4.pages.length === 2 &&
      t4.pages[1].status === 0 &&
      t4.pages[1].error === "connection refused" &&
      t4.errors.length === 1 &&
      t4.errors[0].url === `${FAKE}/bad`,
    `errors: ${t4.errors.map((e) => e.url).join(", ")}`
  );

  // 9e. invalid URL → honest fail-fast rejection.
  try {
    await crawlBounded("not a url at all", { fetchPage: fakeFetch, respectRobots: false });
    check("invalid URL is rejected (unparseable)", false, "crawlBounded unexpectedly succeeded");
  } catch (err) {
    check(
      "invalid URL is rejected (unparseable)",
      err instanceof BlockedUrlError && /unparseable/i.test(err.message),
      err instanceof Error ? err.message.slice(0, 80) : String(err)
    );
  }

  // 9f. SSRF: internal destinations refused before any fetch (fail-fast).
  for (const [bad, label] of [
    ["http://127.0.0.1:3000/", "loopback"],
    ["http://169.254.169.254/latest/meta-data/", "cloud metadata (link-local)"],
    ["http://10.0.0.5/internal", "private range"],
    ["ftp://example.com/", "non-http(s) scheme"],
  ] as const) {
    try {
      await crawlBounded(bad, { fetchPage: fakeFetch });
      check(`crawl SSRF guard blocks ${label}`, false, "unexpectedly succeeded");
    } catch (err) {
      check(
        `crawl SSRF guard blocks ${label}`,
        err instanceof BlockedUrlError,
        err instanceof Error ? err.message.slice(0, 90) : String(err)
      );
    }
  }

  // 9g. REAL crawl against the mandated safe live URL (crawlRetry absorbs
  // transient sandbox-DNS hiccups; any other failure is reported honestly).
  let t5: Awaited<ReturnType<typeof crawlBounded>> | null = null;
  let lastErr: unknown = null;
  try {
    t5 = await crawlRetry("https://example.com", { maxPages: 3, maxDepth: 1 });
  } catch (err) {
    lastErr = err;
  }
  if (t5) {
    check(
      "real crawl of https://example.com — 1 page, 200, limits recorded",
      t5.pages.length === 1 &&
        t5.pages[0].status === 200 &&
        t5.pages[0].title === "Example Domain" &&
        t5.errors.length === 0 &&
        t5.visited[0] === "https://example.com/" &&
        t5.limits.maxPages === 3 &&
        t5.limits.maxDepth === 1 &&
        t5.elapsedMs > 0,
      `pages=${t5.pages.length} status=${t5.pages[0]?.status} title=${t5.pages[0]?.title} ms=${t5.elapsedMs}`
    );
  } else {
    check(
      "real crawl of https://example.com — 1 page, 200, limits recorded",
      false,
      `crawl failed: ${lastErr instanceof Error ? lastErr.message.slice(0, 120) : String(lastErr)}`
    );
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("REGRESSION RUNNER CRASHED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
