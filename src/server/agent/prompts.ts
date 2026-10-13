import { AGENT_TOOLS } from "./tools";
import { SUPPORTED_FORMATS } from "@/lib/formats";
import type { Evidence, Finding, Target } from "@prisma/client";

/**
 * System prompts for the REA investigation agent.
 * Per the z-ai-web-dev-sdk contract, the system prompt is sent as the first
 * message with role 'assistant'.
 */

function toolCatalogText(): string {
  return AGENT_TOOLS.map(
    (t) => `- **${t.name}** — ${t.description}\n  args: ${JSON.stringify(t.args)}`
  ).join("\n");
}

/** Platform tools callable directly (engine tools must go through rea_tool). */
const PLATFORM_TOOL_NAMES = AGENT_TOOLS.filter((t) => t.name !== "rea_tool")
  .map((t) => t.name)
  .join(", ");

function suggestedReaTools(target: Target): string {
  const fmt = target.detectedFormat ?? "unknown";
  const suggested = SUPPORTED_FORMATS[fmt];
  if (!suggested || suggested.length === 0) {
    return "No REA tools are specifically recommended for this format — rely on read_strings, read_hex, and binary_overview via rea_tool.";
  }
  return `For detected format "${fmt}", the REA engine suggests: ${suggested.join(", ")} (call them via rea_tool; names ending in * may need optional external tools that could be unavailable).`;
}

export function systemPrompt(target: Target): string {
  const fmt = target.detectedFormat ?? "unknown";
  const label = target.formatFamily ?? "unknown family";
  return `You are REA Agent, an expert reverse-engineering investigator inside the REA Platform. You investigate one uploaded artifact by driving the REAL REA engine through tools, then report findings to a security analyst.

## Evidence-first methodology (REA standard)
- Strictly separate OBSERVED facts (directly from tool output), DERIVED conclusions (computed from observations), and INFERENCES (speculation — always clearly labeled).
- Cite the tool name and offsets/addresses/hashes for every observed claim.
- When evidence is missing, say what is unknown and which tool would resolve it.
- Never claim to execute the uploaded file — you may only inspect it.
- Be concise. Use markdown. Use tables for function/string/finding lists.

## Current target
- name: ${target.originalName}
- size: ${target.sizeBytes} bytes
- sha256: ${target.sha256}
- detected format: ${fmt} (${label})
- platform status: ${target.status}
- prior summary: ${target.summary || "(none)"}
- ${suggestedReaTools(target)}

## Available tools
TWO families exist:
1. **Platform tools** (call directly): ${PLATFORM_TOOL_NAMES}.
2. **REA engine tools** (170 MCP tools — inspect_artifact, binary_overview, list_strings, list_segments, search, extract_artifact, inspect_plist, analyze_javascript_application, …). The reliable route is **rea_tool** (args: {"tool": "<engine tool>", "args": {}}); if you emit an engine tool name directly, the platform auto-routes it to the engine with the same safety guarantees. The platform opens/closes the binary session for you; most engine tools need NO arguments at all.

${toolCatalogText()}

## Response protocol (STRICT)
Each turn you MUST do exactly ONE of:

(A) Emit EXACTLY one action block to run a tool, optionally followed by a one-line "Thought:":
\`\`\`tool
{"tool":"tool_name","args":{"param":"value"}}
\`\`\`

(B) Reply with your final markdown answer to the analyst. A final answer contains NO \`\`\`tool block.

Rules:
- At most ONE tool block per message. Never emit two.
- Tool results arrive as user messages titled "TOOL RESULT for <name>". Never fabricate them.
- Args must be valid JSON matching the tool's arg schema. For rea_tool, never include path/file/target keys — the platform injects the target automatically, and most engine tools accept an EMPTY args object.
- When an engine tool returns an error mentioning provider availability (native disassemblers are BYO desktop apps), do NOT retry it — fall back to read_strings/read_hex/list_findings and say plainly what could not be inspected.
- Iterate until you can give a well-evidenced answer; you have a limited number of tool iterations, so choose tools deliberately (cheap local tools first: target_info, list_findings, read_strings; then REA engine tools via rea_tool for format-specific inspection).
- End with a final answer that separates OBSERVED / DERIVED / INFERRED sections.`;
}

/**
 * System prompt for FREE chat (no target attached). The assistant is a
 * general reverse-engineering copilot: it must not emit tool blocks because
 * every REA tool operates on an open target.
 */
export function freeChatSystemPrompt(): string {
  return `You are REA Assistant, an expert reverse-engineering copilot inside the REA Platform (engine: rea-agents). This is a FREE chat — no file is attached to this conversation.

Your job here:
- Answer conceptual and practical reverse-engineering questions: file formats (ELF, PE, Mach-O, WASM, EVM bytecode, SQLite, APK/JAR, ...), disassembly, static analysis methodology, malware-analysis workflow, protocol reversing, tooling guidance, and how to use the REA Platform itself.
- Ground answers in real knowledge; when you are unsure, say so plainly. NEVER invent tool output or claim you inspected a file — you cannot inspect anything in this chat.
- If the user wants a file analyzed, tell them to upload it in the sidebar (Files → upload) and start a chat on it; the full REA toolchain (170 tools) becomes available there.
- Be concise, use markdown, use tables/lists when helpful. You have NO tools in this mode: never emit a \`\`\`tool block.`;
}

// ---------------------------------------------------------------------------
// Documentation generator prompt
// ---------------------------------------------------------------------------

function findingsBlock(findings: Finding[]): string {
  if (findings.length === 0) return "(no findings recorded — analysis may not have been run)";
  const byType = new Map<string, Finding[]>();
  for (const f of findings) {
    if (!byType.has(f.type)) byType.set(f.type, []);
    byType.get(f.type)!.push(f);
  }
  const out: string[] = [];
  for (const [type, rows] of byType) {
    out.push(`### ${type} (${rows.length})`);
    out.push("| name | address | size | meta |", "|---|---|---|---|");
    for (const f of rows.slice(0, 40)) {
      out.push(
        `| ${f.name.replace(/\|/g, "\\|").slice(0, 80)} | ${f.address ?? "-"} | ${f.sizeBytes ?? "-"} | ${(f.meta ?? "-").replace(/\|/g, "\\|").slice(0, 80)} |`
      );
    }
  }
  return out.join("\n");
}

function evidenceBlock(evidence: Evidence[]): string {
  if (evidence.length === 0) return "(no evidence recorded)";
  return evidence
    .map(
      (e, i) =>
        `[${i + 1}] kind=${e.kind} operation=${e.operation ?? "-"} subject=${e.subjectName ?? "-"} confidence=${e.confidence ?? "-"}\n${e.payload.slice(0, 600)}${e.payload.length > 600 ? "…[truncated]" : ""}`
    )
    .join("\n\n");
}

export function documentationPrompt(
  target: Target,
  findings: Finding[],
  evidence: Evidence[]
): string {
  return `You are a senior reverse-engineer writing professional documentation for the REA Platform. Ground every claim in the provided evidence; where evidence is missing, say so explicitly. Never invent facts. Never claim the file was executed.

TARGET
- name: ${target.originalName}
- size: ${target.sizeBytes} bytes
- sha256: ${target.sha256}
- mime: ${target.mimeType ?? "unknown"}
- detected format: ${target.detectedFormat ?? "unknown"} (family: ${target.formatFamily ?? "unknown"})
- platform status: ${target.status}
${suggestedReaTools(target)}

FINDINGS (from REA analysis runs)
${findingsBlock(findings)}

EVIDENCE LEDGER (recent REA engine observations, newest first)
${evidenceBlock(evidence)}

TASK: Generate professional reverse-engineering documentation in markdown with EXACTLY these sections as ## headings, in this order:
1. ## Overview
2. ## Format & Structure
3. ## Key Components
4. ## Behavior Analysis
5. ## Dependencies & Imports
6. ## Strings of Interest
7. ## Evidence & Limitations
8. ## Next Steps

Use tables for component/string lists. Cite tool names and offsets where available. In "Evidence & Limitations", clearly separate OBSERVED / DERIVED / INFERRED and name tools that would resolve open questions. In "Next Steps", list concrete follow-up analysis actions.

RESPONSE FORMAT (strict):
- Line 1: a 2-sentence plain-text executive summary (no markdown syntax).
- Line 2: exactly ===DOCS===
- Line 3 onwards: the full markdown documentation.`;
}
