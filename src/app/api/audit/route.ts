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

    // TENANT ISOLATION: users see only their own audit trail — never other
    // accounts' events (emails/IPs were previously disclosed cross-tenant).
    const events = await db.auditLog.findMany({
      where: { userId: user.id },
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
