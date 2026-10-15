/**
 * RE-toolchain agent tools (Capability C1) — the agent's hands on the
 * classical RE instrument rack: list what is available (re_tools) and run
 * it (re_tool) with honest availability reporting. Scope "any": usable in
 * free chats (with a target id + ownership check) and target chats alike.
 *
 * These are thin adapters: all execution policy lives in
 * src/server/retools/runner.ts (storage-input guard, no-shell argv, sandbox
 * posture, capped receipts). Nothing here invents output.
 */

import path from "node:path";
import type { Target } from "@prisma/client";
import { db } from "@/lib/db";
import type { AgentTool, AgentToolContext } from "./tools";
import {
  listRegistryWithAvailability,
  renderRunResult,
  runReTool,
} from "@/server/retools/runner";
import type { ReToolOperation } from "@/server/retools/registry";

/**
 * retools ctx is deliberately wider than AgentToolContext: any-scoped tools
 * are also routable in free chats where no target is attached.
 */
type ToolCtx = Omit<AgentToolContext, "target"> & { target: Target | null };

function trimReceipt(s: string): string {
  return s.length > 6_000 ? `${s.slice(0, 6_000)}\n… [receipt truncated]` : s;
}

/** Resolve the input file for a re_tool invocation. */
async function resolveInput(
  args: Record<string, unknown>,
  ctx: ToolCtx
): Promise<string> {
  const targetId = typeof args.targetId === "string" ? args.targetId.trim() : "";
  const rawPath = typeof args.path === "string" ? args.path.trim() : "";

  if (targetId) {
    // Ownership: the caller must own the target (or have it attached).
    const t = await db.target.findUnique({ where: { id: targetId } });
    if (!t || t.userId !== ctx.userId) {
      throw new Error(`Error: target '${targetId}' not found in your workspace (ownership is enforced).`);
    }
    const stored = t.storedPath;
    return path.isAbsolute(stored) ? stored : path.resolve(process.cwd(), stored);
  }

  if (rawPath) {
    return path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath);
  }

  // Convenience: the attached target in a target-scoped chat.
  if (ctx.target?.storedPath) {
    const stored = ctx.target.storedPath;
    return path.isAbsolute(stored) ? stored : path.resolve(process.cwd(), stored);
  }

  throw new Error("Error: re_tool needs an input — pass targetId, a path under storage/, or run it in a chat with a target attached.");
}

export async function runReToolsList(
  _args: Record<string, unknown>,
  _ctx: ToolCtx
): Promise<string> {
  const entries = await listRegistryWithAvailability();
  const lines: string[] = ["RE toolchain registry (availability probed live):"];
  for (const e of entries) {
    const license = e.license ? " [license required]" : "";
    lines.push(
      `- ${e.id} (${e.name})${license} — kinds: ${e.kinds.join("/")}; operations: ${Object.keys(e.operations).join(", ")}; availability: ${e.availability.mode}${e.availability.mode === "unavailable" ? ` — ${e.availability.detail}` : ` (${e.availability.detail})`}`
    );
  }
  lines.push("Run one with re_tool { tool, operation, targetId|path }.");
  return trimReceipt(lines.join("\n"));
}

export async function runReToolRun(
  args: Record<string, unknown>,
  ctx: ToolCtx
): Promise<string> {
  const tool = typeof args.tool === "string" ? args.tool.trim() : "";
  const operation = typeof args.operation === "string" ? args.operation.trim() : "";
  if (!tool) throw new Error("Error: re_tool requires 'tool' (see re_tools for the registry).");
  if (!operation) {
    throw new Error("Error: re_tool requires 'operation' (decompile | disassemble | functions | info | symbolic — per-tool support varies).");
  }

  const inputPath = await resolveInput(args, ctx);
  const result = await runReTool(tool, {
    inputPath,
    operation: operation as ReToolOperation,
  });
  return trimReceipt(renderRunResult(result));
}

const reToolsListTool: AgentTool = {
  name: "re_tools",
  scope: "any",
  description:
    "List the classical reverse-engineering toolchain REA can orchestrate (Ghidra, rizin, pycdc/pycdas, angr; IDA/Hopper appear only when the operator supplies licensed images). Each entry reports kinds (disassembler/decompiler/symbolic-executor), supported operations (decompile | disassemble | functions | info | symbolic), and LIVE availability: a docker image, a local binary, or honestly unavailable with the exact command to enable it. Call this before re_tool to pick the right instrument.",
  args: { type: "object", properties: {}, additionalProperties: false },
  run: runReToolsList,
};

const reToolRunTool: AgentTool = {
  name: "re_tool",
  scope: "any",
  description:
    "Run a classical RE tool from the registry on a binary. Operations: 'decompile' (C-like pseudocode), 'disassemble', 'functions' (list), 'info' (format/metadata), 'symbolic' (angr symbolic execution). Input: targetId of an owned uploaded target, or an absolute path under the platform storage tree (uploads/workspaces). Execution is sandboxed (container without network, or direct spawn without a shell); output is the tool's REAL stdout/stderr plus any produced artifacts, never invented. Tools that are not installed return their exact enable instructions instead of pretending.",
  args: {
    type: "object",
    properties: {
      tool: { type: "string", description: 'Registry tool id, e.g. "ghidra", "rizin", "pycdc", "pycdas", "angr".' },
      operation: { type: "string", description: "decompile | disassemble | functions | info | symbolic (per-tool support; see re_tools)." },
      targetId: { type: "string", description: "Id of an owned uploaded Target to analyze." },
      path: { type: "string", description: "Alternative: absolute path under storage/ (uploads or workspaces)." },
    },
    required: ["tool", "operation"],
    additionalProperties: false,
  },
  run: runReToolRun,
};

export const RETOOLS_AGENT_TOOLS: AgentTool[] = [reToolsListTool, reToolRunTool];
