import { NextResponse } from "next/server";
import { clearSessionCookie, getSessionUser } from "@/lib/auth";
import { audit, clientIp } from "@/lib/security";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const user = await getSessionUser();
    await clearSessionCookie();
    if (user) {
      await audit("auth.logout", {
        userId: user.id,
        detail: `logout ${user.email}`,
        ip: clientIp(req),
      });
    }
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Logout failed" },
      { status: 500 }
    );
  }
}
