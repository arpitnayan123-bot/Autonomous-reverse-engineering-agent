import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { db } from "@/lib/db";
import path from "node:path";
import {
  getTool,
  listRegistryWithAvailability,
  renderRunResult,
  runReTool,
  type ReToolRunResult,
} from "@/server/retools/runner";
import type { ReToolOperation } from "@/server/retools/registry";

/**
 * RE toolchain REST surface (Capability C1).
 *
 * GET  /api/retools                       → registry with live availability
 * POST /api/retools { tool, operation, targetId?|path? } → run a tool
 *
 * The run endpoint enforces the same policy as the agent tool: target
 * ownership, storage-tree input guard, sandboxed execution, capped output.
 */

export const runtime = "nodejs";

const OPERATIONS = new Set(["decompile", "disassemble", "functions", "info", "symbolic"]);

export async function GET() {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "Authentication required" }, { status: 401 });
  }
  const registry = await listRegistryWithAvailability();
  return NextResponse.json({
    ok: true,
    tools: registry.map((t) => ({
      id: t.id,
      name: t.name,
      kinds: t.kinds,
      image: t.image,
      operations: Object.keys(t.operations),
      profile: t.profile,
      license: t.license ?? null,
      description: t.description,
      docs: t.docs,
      availability: t.availability,
    })),
  });
}

async function resolveInputForApi(
  body: Record<string, unknown>,
  userId: string
): Promise<string> {
  const targetId = typeof body.targetId === "string" ? body.targetId.trim() : "";
  const rawPath = typeof body.path === "string" ? body.path.trim() : "";
  if (targetId) {
    const t = await db.target.findUnique({ where: { id: targetId } });
    if (!t || t.userId !== userId) {
      throw new Error(`target '${targetId}' not found in your workspace (ownership is enforced)`);
    }
    return path.isAbsolute(t.storedPath) ? t.storedPath : path.resolve(process.cwd(), t.storedPath);
  }
  if (rawPath) {
    return path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath);
  }
  throw new Error("input required: pass targetId or path (under platform storage)");
}

export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "Authentication required" }, { status: 401 });
  }
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  const tool = typeof body.tool === "string" ? body.tool.trim() : "";
  const operation = typeof body.operation === "string" ? body.operation.trim() : "";
  if (!tool || !operation) {
    return NextResponse.json({ ok: false, error: "tool and operation are required" }, { status: 400 });
  }
  if (!OPERATIONS.has(operation)) {
    return NextResponse.json({ ok: false, error: `unknown operation '${operation}'` }, { status: 400 });
  }
  const spec = await getTool(tool);
  if (!spec) {
    return NextResponse.json({ ok: false, error: `unknown tool '${tool}' — see GET /api/retools` }, { status: 404 });
  }
  if (!spec.operations[operation as ReToolOperation]) {
    return NextResponse.json({ ok: false, error: `tool '${tool}' does not support operation '${operation}'` }, { status: 400 });
  }

  let inputPath: string;
  try {
    inputPath = await resolveInputForApi(body, user.id);
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "input resolution failed" }, { status: 400 });
  }

  try {
    const result: ReToolRunResult = await runReTool(tool, {
      inputPath,
      operation: operation as ReToolOperation,
    });
    return NextResponse.json({ ok: true, receipt: renderRunResult(result), result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.startsWith("Error:") ? 400 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
