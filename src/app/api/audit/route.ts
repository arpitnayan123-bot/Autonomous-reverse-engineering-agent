import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET() {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Authentication required" },
        { status: 401 }
      );
    }

    const events = await db.auditLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
    });

    return NextResponse.json({ ok: true, events });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Could not load audit log" },
      { status: 500 }
    );
  }
}
