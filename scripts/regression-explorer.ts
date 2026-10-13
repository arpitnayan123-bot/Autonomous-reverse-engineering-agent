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
import { probeUrl } from "@/server/platform/explorer";
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

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("REGRESSION RUNNER CRASHED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
