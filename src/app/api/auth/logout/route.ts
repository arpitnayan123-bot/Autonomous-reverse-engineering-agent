import { NextResponse } from "next/server";
import {
  clearSessionCookie,
  getSessionUser,
  purgeStaleSessions,
  revokeCurrentSession,
} from "@/lib/auth";
import { audit, clientIp } from "@/lib/security";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const user = await getSessionUser();
    // Revoke the server-side session record FIRST, then drop the cookie. Any
    // copy of this token (stolen or otherwise) is dead the moment this runs.
    await revokeCurrentSession();
    if (user) await purgeStaleSessions(user.id);
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
