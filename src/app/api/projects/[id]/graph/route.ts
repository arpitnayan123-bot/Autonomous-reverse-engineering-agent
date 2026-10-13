import { NextResponse } from "next/server";
import { requireProject, serverError } from "@/server/platform/api-helpers";
import { graphSnapshot } from "@/server/platform/graph";

export const runtime = "nodejs";
export const maxDuration = 60;

interface Ctx {
  params: Promise<{ id: string }>;
}

/** GET /api/projects/[id]/graph — knowledge-graph snapshot (nodes + edges). */
export async function GET(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const auth = await requireProject(id);
    if (auth instanceof NextResponse) return auth;
    const url = new URL(req.url);
    const kind = url.searchParams.get("kind");
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 400) || 400, 600);
    const snapshot = await graphSnapshot(id, limit);
    return NextResponse.json({
      ok: true,
      graph: kind ? { ...snapshot, nodes: snapshot.nodes.filter((n) => n.kind === kind) } : snapshot,
    });
  } catch (err) {
    console.error("graph error:", err);
    return serverError("Could not load knowledge graph");
  }
}
