#!/usr/bin/env bun
/**
 * REA agent tool-execution reliability regression.
 *
 * Proves the model-to-tool handoff actually executes tools instead of
 * silently degrading them into prose, and that every refusal is honest:
 *   - the tool-block parser accepts the canonical fence AND the realistic
 *     spelling variants models emit (space/case/tilde/unterminated);
 *   - unknown tools, non-allowlisted engine tools and missing args return
 *     actionable error STRINGS (never thrown, never fabricated);
 *   - plan/explore tools execute for real (real network for explore_url);
 *   - cross-turn tool receipts and the scoped redirect notice exist so the
 *     model never concludes "I cannot access tools" after tools worked;
 *   - both system prompts carry the anti-refusal + capability-boundary
 *     clauses (contract tests).
 *
 * Live network: https://example.com only (the mandated safe host).
 * Run:  bun scripts/regression-agent.ts
 * Exit: 0 = all checks passed, 1 = at least one failure (printed).
 */
import {
  parseToolAction,
  toolReceiptSuffix,
  freeChatRedirectNotice,
} from "@/server/agent/agent";
import {
  AGENT_TOOLS,
  executeAgentTool,
  applyPlanUpdate,
  runExploreUrlTool,
} from "@/server/agent/tools";
import { freeChatSystemPrompt, systemPrompt } from "@/server/agent/prompts";
import { BlockedUrlError } from "@/server/platform/net";
import type { Target } from "@prisma/client";

let failures = 0;

function check(name: string, ok: boolean, detail?: string): void {
  const mark = ok ? "PASS" : "FAIL";
  console.log(`${mark}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function section(title: string): void {
  console.log(`\n## ${title}`);
}

// explore_url / allowlist-error paths never touch the target or engine.
const stubCtx = { target: {} as Target, userId: "regression" };

/** Bounded retry for transient sandbox-DNS hiccups on the real fetch. */
async function withDnsRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const transient = err instanceof BlockedUrlError === false && /dns/i.test(msg);
      if (!transient || attempt === 3) throw err;
      console.log(`  (${label} attempt ${attempt} hit transient DNS failure, retrying)`);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw lastErr;
}

const TOOL_BLOCK = '```tool\n{"tool":"explore_url","args":{"url":"https://example.com"}}\n```';

async function main(): Promise<void> {
  console.log("REA agent tool-execution reliability regression\n");

  // ---------------------------------------------------------------------
  section("A. Tool-block parsing (model-to-tool handoff)");
  // ---------------------------------------------------------------------

  const canonical = parseToolAction(`Thought: fetch the page.\n${TOOL_BLOCK}`);
  check(
    "A1  canonical closed block parses",
    canonical?.tool === "explore_url" && canonical.args.url === "https://example.com",
    JSON.stringify(canonical)
  );

  const lastWins = parseToolAction(
    `${TOOL_BLOCK}\nand then:\n\`\`\`tool\n{"tool":"update_plan","args":{"tasks":[{"title":"a","status":"in_progress"},{"title":"b","status":"pending"}]}}\n\`\`\``
  );
  check("A2  LAST block wins when two are present", lastWins?.tool === "update_plan", JSON.stringify(lastWins));

  const spaced = parseToolAction('``` tool\n{"tool":"explore_url","args":{}}\n```');
  check(
    "A3  '``` tool' (space after fence) parses — was silently degraded to prose",
    spaced?.tool === "explore_url",
    JSON.stringify(spaced)
  );

  const upper = parseToolAction('```TOOL\n{"tool":"explore_url","args":{}}\n```');
  check("A4  '```TOOL' (upper-case) parses", upper?.tool === "explore_url", JSON.stringify(upper));

  const tilde = parseToolAction('~~~tool\n{"tool":"explore_url","args":{}}\n~~~');
  check("A5  tilde fence parses", tilde?.tool === "explore_url", JSON.stringify(tilde));

  const crlf = parseToolAction('```tool\r\n{"tool":"explore_url","args":{}}\r\n```');
  check("A6  CRLF block parses", crlf?.tool === "explore_url", JSON.stringify(crlf));

  const indented = parseToolAction('intro\n\n  ```tool\n  {"tool":"explore_url","args":{}}\n  ```');
  check("A7  indented fence parses", indented?.tool === "explore_url", JSON.stringify(indented));

  const unterminated = parseToolAction('```tool\n{"tool":"explore_url","args":{"url":"https://example.com"}}');
  check(
    "A8  unterminated block with valid JSON parses (forgot-closing-fence fallback)",
    unterminated?.tool === "explore_url" && unterminated.args.url === "https://example.com",
    JSON.stringify(unterminated)
  );

  const unterminatedGarbage = parseToolAction("```tool\nthis is prose, not json");
  check(
    "A9  unterminated block with non-JSON tail is NOT executed (null → final answer)",
    unterminatedGarbage === null,
    JSON.stringify(unterminatedGarbage)
  );

  check("A10 plain prose yields null", parseToolAction("Just answer, no tools needed.") === null);

  const malformed = parseToolAction('```tool\n{"tool": explore_url}\n```');
  check(
    "A11 malformed JSON inside a closed block yields null (existing behavior kept)",
    malformed === null,
    JSON.stringify(malformed)
  );

  const jsonFence = parseToolAction('```json\n{"tool":"explore_url","args":{}}\n```');
  check("A12 non-tool fence (```json) yields null", jsonFence === null, JSON.stringify(jsonFence));

  const closedBeatsTail = parseToolAction(
    `${TOOL_BLOCK}\n\nUnrelated trailing text with an unterminated opener:\n\`\`\`tool\n{"tool":"rea_tool","args":{"tool":"search"}}`
  );
  check(
    "A13 closed block takes priority over a later unterminated opener",
    closedBeatsTail?.tool === "explore_url",
    JSON.stringify(closedBeatsTail)
  );

  // ---------------------------------------------------------------------
  section("B. Registry execution + honest error handling");
  // ---------------------------------------------------------------------

  const unknown = await executeAgentTool("no_such_tool", {}, stubCtx);
  check(
    "B1  unknown tool returns actionable error string (never throws)",
    unknown.startsWith("Error: unknown tool") &&
      unknown.includes("target_info") &&
      unknown.includes("rea_tool"),
    unknown.slice(0, 120)
  );

  const notAllowed = await executeAgentTool(
    "rea_tool",
    { tool: "definitely_not_allowlisted", args: {} },
    stubCtx
  );
  check(
    "B2  non-allowlisted engine tool refused before any engine contact",
    notAllowed.includes('not allowlisted') && notAllowed.includes("inspect_artifact"),
    notAllowed.slice(0, 120)
  );

  const missingTool = await executeAgentTool("rea_tool", { args: {} }, stubCtx);
  check("B3  rea_tool without 'tool' arg returns usage error", missingTool.startsWith("Error: 'tool' is required."), missingTool.slice(0, 80));

  const plan = await applyPlanUpdate({
    tasks: [
      { title: "Step 1", status: "in_progress" },
      { title: "Step 2", status: "pending" },
      { title: "Step 3", status: "pending" },
    ],
  });
  check(
    "B4  update_plan executes for real",
    plan.includes("Plan updated: 3 steps") && plan.includes("now working on: Step 1"),
    plan
  );

  const planBad = await applyPlanUpdate({ tasks: [{ title: "only one" }] });
  check(
    "B5  malformed plan returns format help (honest error)",
    planBad.startsWith("Error:") && planBad.includes("2-8 items"),
    planBad.slice(0, 100)
  );

  const planDouble = await applyPlanUpdate({
    tasks: [
      { title: "First", status: "in_progress" },
      { title: "Second", status: "in_progress" },
    ],
  });
  check(
    "B6  two in_progress steps downgraded to a single focus",
    planDouble.includes("now working on: First") && !planDouble.includes("Second"),
    planDouble
  );

  const noUrl = await runExploreUrlTool({});
  check(
    "B7  explore_url without url returns usage error",
    noUrl.startsWith("Error:") && noUrl.includes("'url' is required"),
    noUrl.slice(0, 100)
  );

  const ftp = await runExploreUrlTool({ url: "ftp://example.com/x" });
  check(
    "B8  unsafe scheme refused through the SSRF guard",
    ftp.startsWith("Error:") && ftp.includes("SSRF guard"),
    ftp.slice(0, 140)
  );

  const unparseable = await runExploreUrlTool({ url: "not a url at all" });
  check(
    "B9  unparseable URL refused as BlockedUrlError path",
    unparseable.startsWith("Error:") && unparseable.includes("SSRF guard"),
    unparseable.slice(0, 140)
  );

  const live = await withDnsRetry(
    () => runExploreUrlTool({ url: "https://example.com" }),
    "example.com"
  );
  check(
    "B10 agent explore_url executes a REAL fetch of https://example.com",
    live.includes("# explore_url — OBSERVED fetch") &&
      live.includes("status: 200") &&
      live.includes("Example Domain"),
    live.split("\n").slice(0, 5).join(" | ")
  );

  // ---------------------------------------------------------------------
  section("C. Cross-turn receipts + scoped redirect + prompt contracts");
  // ---------------------------------------------------------------------

  check("C1  toolReceiptSuffix(null) → empty", toolReceiptSuffix(null) === "");
  check("C2  toolReceiptSuffix(garbage) → empty", toolReceiptSuffix("not json{") === "");
  check(
    "C3  toolReceiptSuffix(non-array json) → empty",
    toolReceiptSuffix('{"tool":"explore_url"}') === ""
  );

  const trace = JSON.stringify([
    {
      tool: "explore_url",
      args: { url: "https://example.com" },
      result: "# explore_url — OBSERVED fetch\n- status: 200\nExample Domain text",
    },
  ]);
  const receipt = toolReceiptSuffix(trace);
  check(
    "C4  receipt lists tool, args, result and is labeled as system-injected",
    receipt.includes("[SYSTEM receipt") &&
      receipt.includes("explore_url") &&
      receipt.includes("https://example.com") &&
      receipt.includes("status: 200"),
    receipt.slice(0, 160)
  );

  const many = JSON.stringify(
    Array.from({ length: 6 }, (_, i) => ({ tool: `t${i}`, args: {}, result: "r" }))
  );
  const capped = toolReceiptSuffix(many);
  check(
    "C5  receipt caps at 5 tool lines",
    (capped.match(/^- /gm) ?? []).length === 5,
    `${(capped.match(/^- /gm) ?? []).length} lines`
  );

  const longResult = "x".repeat(400);
  const truncated = toolReceiptSuffix(
    JSON.stringify([{ tool: "t", args: {}, result: longResult }])
  );
  check(
    "C6  long result truncated to 160 chars with ellipsis",
    truncated.includes("x".repeat(160) + "…") && !truncated.includes("x".repeat(200)),
    `len=${truncated.length}`
  );

  const notice = freeChatRedirectNotice("target_info");
  check(
    "C7  redirect notice scopes refusal to THAT tool and re-asserts working tools",
    notice.includes('"target_info"') &&
      notice.includes("unavailable here") &&
      notice.includes("update_plan and explore_url remain fully functional") &&
      !notice.includes("Do not emit tool blocks"),
    notice.slice(0, 120)
  );

  const freePrompt = freeChatSystemPrompt();
  check(
    "C8  free-chat prompt forbids denying tool access",
    freePrompt.includes('NEVER say that you "cannot access tools"') &&
      freePrompt.includes("Tool execution in this chat is REAL"),
    ""
  );
  check(
    "C9  free-chat prompt states the precise capability boundary",
    freePrompt.includes("NO tool for running shell commands") &&
      freePrompt.includes('not "tools are unavailable"'),
    ""
  );

  const fakeTarget = {
    id: "t",
    originalName: "sample.elf",
    sizeBytes: 1024,
    sha256: "ab".repeat(32),
    mimeType: "application/octet-stream",
    detectedFormat: "elf",
    formatFamily: "elf",
    status: "ready",
    summary: "",
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as Target;
  const targetPrompt = systemPrompt(fakeTarget);
  check(
    "C10 target-chat prompt forbids denying tool access",
    targetPrompt.includes('NEVER claim you "cannot access tools"') &&
      targetPrompt.includes("tools are REAL and already work"),
    ""
  );
  check(
    "C11 target-chat prompt states the precise capability boundary",
    targetPrompt.includes("no shell or test-suite runner") &&
      targetPrompt.includes("THIS capability is unavailable"),
    ""
  );
  check(
    "C12 registry names all appear in the target-chat catalog (no prompt/registry drift)",
    AGENT_TOOLS.every((t) => targetPrompt.includes(`**${t.name}**`)),
    AGENT_TOOLS.map((t) => t.name).join(", ")
  );

  // ---------------------------------------------------------------------
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error("regression-agent crashed:", err);
  process.exit(1);
});
