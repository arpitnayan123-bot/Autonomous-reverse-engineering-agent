/**
 * Client-side Markdown exporters — build downloadable reports from chat
 * transcripts and target investigations. No server round-trip needed beyond
 * the existing data endpoints.
 */

import type {
  ChatMessageRow,
  EvidenceRow,
  Finding,
  TargetDetail,
} from "@/lib/api-client";

/** Trigger a browser download of a Markdown file. */
export function downloadMarkdown(filename: string, markdown: string): void {
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function safeFilePart(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "export"
  );
}

interface ToolTraceRow {
  tool?: string;
  args?: unknown;
  result?: string;
}

function toolTraceMarkdown(rawToolCalls: string | null): string {
  if (!rawToolCalls) return "";
  let parsed: ToolTraceRow[] | null = null;
  try {
    parsed = JSON.parse(rawToolCalls) as ToolTraceRow[];
  } catch {
    return "";
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return "";
  const rows = parsed
    .map((t) => {
      const args = t.args && Object.keys(t.args).length > 0 ? JSON.stringify(t.args) : "";
      const result = (t.result ?? "").trim();
      return [
        `- **${t.tool ?? "tool"}**${args ? ` \`${args}\`` : ""}`,
        result ? `\n  \`\`\`\n  ${result.slice(0, 800).replace(/\n/g, "\n  ")}\n  \`\`\`` : "",
      ].join("");
    })
    .join("\n");
  return `\n<details><summary>Tool calls (${parsed.length})</summary>\n\n${rows}\n\n</details>\n`;
}

// ---------------------------------------------------------------------------
// Chat transcript
// ---------------------------------------------------------------------------

export function buildChatMarkdown(
  title: string,
  messages: ChatMessageRow[],
  context?: { targetName?: string | null; detectedFormat?: string | null }
): string {
  const header = [
    `# ${title}`,
    "",
    `_Exported from REA Platform — ${new Date().toISOString()}_`,
    context?.targetName
      ? `\n**Target:** ${context.targetName}${context.detectedFormat ? ` (\`${context.detectedFormat}\`)` : ""}`
      : "\n**Mode:** free chat (no file attached)",
    "",
    "---",
    "",
  ].join("\n");

  const body = messages
    .map((m) => {
      const who = m.role === "assistant" ? "## REA Agent" : "## You";
      const meta: string[] = [];
      if (m.role === "assistant") {
        if (m.tokensIn != null || m.tokensOut != null) {
          meta.push(
            `tokens: ↑${m.tokensIn ?? "?"} ↓${m.tokensOut ?? "?"}`
          );
        }
        if (m.durationMs != null) meta.push(`duration: ${(m.durationMs / 1000).toFixed(1)}s`);
      }
      const metaLine = meta.length > 0 ? `\n\n_${meta.join(" · ")}_` : "";
      return `${who}\n${metaLine}\n\n${m.content.trim() || "_(empty)_"}\n${toolTraceMarkdown(m.toolCalls)}`;
    })
    .join("\n---\n\n");

  return `${header}${body}\n`;
}

export function exportChat(
  title: string,
  messages: ChatMessageRow[],
  context?: { targetName?: string | null; detectedFormat?: string | null }
): void {
  downloadMarkdown(`${safeFilePart(title)}.md`, buildChatMarkdown(title, messages, context));
}

// ---------------------------------------------------------------------------
// Target investigation report
// ---------------------------------------------------------------------------

function findingsMarkdown(findings: Finding[]): string {
  if (findings.length === 0) return "_No findings recorded._\n";
  const byType = new Map<string, Finding[]>();
  for (const f of findings) {
    if (!byType.has(f.type)) byType.set(f.type, []);
    byType.get(f.type)!.push(f);
  }
  const out: string[] = [];
  const metaText = (meta: unknown): string => {
    if (meta == null) return "-";
    if (typeof meta === "string") return meta;
    try {
      return JSON.stringify(meta);
    } catch {
      return String(meta);
    }
  };
  for (const [type, rows] of byType) {
    out.push(`### ${type} (${rows.length})`, "", "| name | address | size | meta |", "|---|---|---|---|");
    for (const f of rows.slice(0, 60)) {
      out.push(
        `| ${String(f.name ?? "-").replace(/\|/g, "\\|").slice(0, 80)} | ${f.address ?? "-"} | ${f.sizeBytes ?? "-"} | ${metaText(f.meta).replace(/\|/g, "\\|").slice(0, 80)} |`
      );
    }
    out.push("");
  }
  return out.join("\n");
}

function evidenceMarkdown(evidence: EvidenceRow[]): string {
  if (evidence.length === 0) return "_No evidence recorded._\n";
  return (
    evidence
      .slice(0, 40)
      .map(
        (e, i) =>
          `${i + 1}. **[${e.kind.toUpperCase()}]** ${e.operation ?? "-"}${e.subjectName ? ` · \`${e.subjectName}\`` : ""}${e.confidence != null ? ` · confidence: ${e.confidence}` : ""}`
      )
      .join("\n") + "\n"
  );
}

export async function buildTargetReportMarkdown(target: TargetDetail): Promise<string> {
  const [findingsRes, evidenceRes, docsRes] = await Promise.all([
    fetch(`/api/targets/${target.id}/findings?limit=500`).then((r) => r.json()).catch(() => null),
    fetch(`/api/targets/${target.id}/evidence`).then((r) => r.json()).catch(() => null),
    fetch(`/api/targets/${target.id}/docs`).then((r) => r.json()).catch(() => null),
  ]);
  const findings = ((findingsRes && findingsRes.ok && findingsRes.findings) || []) as Finding[];
  const evidence = ((evidenceRes && evidenceRes.ok && evidenceRes.evidence) || []) as EvidenceRow[];
  const docs = ((docsRes && docsRes.ok && docsRes.docs) || "") as string;

  const latestRun = target.runs?.[0];
  const sections: string[] = [
    `# Investigation report — ${target.originalName}`,
    "",
    `_Generated by REA Platform on ${new Date().toISOString()}_`,
    "",
    "## File identity",
    "",
    `- **Size:** ${target.sizeBytes} bytes`,
    `- **SHA-256:** \`${target.sha256}\``,
    `- **Detected format:** ${target.detectedFormat ?? "unknown"}${target.formatLabel ? ` — ${target.formatLabel}` : ""}`,
    target.formatFamily ? `- **Family:** ${target.formatFamily}` : "",
    latestRun
      ? `- **Latest analysis:** ${latestRun.status}${latestRun.durationMs ? ` in ${Math.round(latestRun.durationMs / 100) / 10}s` : ""}`
      : "- **Latest analysis:** not run",
    "",
    "## Findings",
    "",
    findingsMarkdown(findings),
    "## Evidence ledger",
    "",
    evidenceMarkdown(evidence),
  ];

  if (docs.trim()) {
    sections.push("## Generated documentation", "", docs.trim(), "");
  } else {
    sections.push(
      "## Generated documentation",
      "",
      "_No AI documentation generated yet — use **Generate docs** in the inspector._",
      ""
    );
  }

  return sections.filter((s) => s !== "").join("\n");
}

export async function exportTargetReport(target: TargetDetail): Promise<void> {
  const md = await buildTargetReportMarkdown(target);
  downloadMarkdown(`${safeFilePart(target.originalName)}-report.md`, md);
}
