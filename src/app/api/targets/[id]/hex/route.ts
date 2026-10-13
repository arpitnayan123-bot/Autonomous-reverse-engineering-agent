import fs from "node:fs/promises";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { isSafeId } from "@/lib/security";
import { resolveStoragePath } from "@/server/engine/strings";

export const runtime = "nodejs";

const HEX_ROW_WIDTH = 16;
const MAX_HEX_LENGTH = 4096;

function toAscii(bytes: number[]): string {
  let out = "";
  for (const b of bytes) {
    out += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : ".";
  }
  return out;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let handle: fs.FileHandle | null = null;
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Authentication required" },
        { status: 401 }
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
    const offset = Number(url.searchParams.get("offset") ?? "0");
    const length = Number(url.searchParams.get("length") ?? "512");
    if (!Number.isInteger(offset) || offset < 0) {
      return NextResponse.json(
        { ok: false, error: "offset must be a non-negative integer" },
        { status: 400 }
      );
    }
    if (!Number.isInteger(length) || length < 1 || length > MAX_HEX_LENGTH) {
      return NextResponse.json(
        { ok: false, error: `length must be an integer between 1 and ${MAX_HEX_LENGTH}` },
        { status: 400 }
      );
    }

    const absPath = resolveStoragePath(target.storedPath);
    if (!absPath) {
      return NextResponse.json(
        { ok: false, error: "Target file unavailable" },
        { status: 404 }
      );
    }

    handle = await fs.open(absPath, "r");
    const stat = await handle.stat();
    if (offset >= stat.size) {
      return NextResponse.json({
        ok: true,
        offset,
        length: 0,
        fileSize: stat.size,
        hex: [],
        raw: "",
      });
    }
    const buffer = Buffer.alloc(Math.min(length, stat.size - offset));
    const { bytesRead } = await handle.read(
      buffer,
      0,
      buffer.length,
      offset
    );

    const rows: Array<{ offset: number; bytes: number[]; ascii: string }> = [];
    for (let i = 0; i < bytesRead; i += HEX_ROW_WIDTH) {
      const slice = buffer.subarray(i, Math.min(i + HEX_ROW_WIDTH, bytesRead));
      const bytes = Array.from(slice);
      rows.push({
        offset: offset + i,
        bytes,
        ascii: toAscii(bytes).padEnd(HEX_ROW_WIDTH, "."),
      });
    }

    return NextResponse.json({
      ok: true,
      offset,
      length: bytesRead,
      fileSize: stat.size,
      hex: rows,
      raw: buffer.subarray(0, bytesRead).toString("hex"),
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Could not read bytes" },
      { status: 500 }
    );
  } finally {
    try {
      await handle?.close();
    } catch {
      /* already closed */
    }
  }
}
