import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { isSafeId, rateLimit } from "@/lib/security";
import { getStringsForTarget, resolveStoragePath } from "@/server/engine/strings";

export const runtime = "nodejs";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Authentication required" },
        { status: 401 }
      );
    }
    // Extraction can cost a full scan of a 50 MB file on cache miss — bound it.
    const rl = rateLimit(`strings:${user.id}`, 30, 60_000);
    if (!rl.allowed) {
      return NextResponse.json(
        { ok: false, error: "Too many string extractions — slow down", retryAfterSec: rl.retryAfterSec },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
      );
    }
    const { id } = await params;
    if (!isSafeId(id)) {
      return NextResponse.json(
        { ok: false, error: "Invalid target id" },
        { status: 400 }
      );
    }
    const target = await db.target.findUnique({ where: { id } });
    if (!target || target.userId !== user.id) {
      return NextResponse.json(
        { ok: false, error: "Target not found" },
        { status: 404 }
      );
    }

    const url = new URL(req.url);
    const q = url.searchParams.get("q")?.trim().toLowerCase() ?? "";
    const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
    const pageSizeRaw = Number(url.searchParams.get("pageSize") ?? "100") || 100;
    const pageSize = Math.min(Math.max(Math.round(pageSizeRaw), 1), 200);

    const absPath = resolveStoragePath(target.storedPath);
    if (!absPath) {
      return NextResponse.json(
        { ok: false, error: "Target file unavailable" },
        { status: 404 }
      );
    }

    const all = await getStringsForTarget(target.id, absPath);
    const filtered = q
      ? all.filter((s) => s.value.toLowerCase().includes(q))
      : all;
    const total = filtered.length;
    const start = (page - 1) * pageSize;
    const strings = filtered.slice(start, start + pageSize);

    return NextResponse.json({ ok: true, strings, total, page, pageSize });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Could not extract strings" },
      { status: 500 }
    );
  }
}
