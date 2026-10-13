import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET() {
  try {
    const user = await getSessionUser();
    return NextResponse.json({ ok: true, user });
  } catch (err) {
    // A DB outage must not look like "logged out" (clients would loop the
    // login flow) — surface a real failure.
    console.error("auth/me error:", err);
    return NextResponse.json(
      { ok: false, error: "Could not verify session" },
      { status: 503 }
    );
  }
}
