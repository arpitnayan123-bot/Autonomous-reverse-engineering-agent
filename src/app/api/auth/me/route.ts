import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET() {
  try {
    const user = await getSessionUser();
    return NextResponse.json({ ok: true, user });
  } catch {
    return NextResponse.json({ ok: true, user: null });
  }
}
