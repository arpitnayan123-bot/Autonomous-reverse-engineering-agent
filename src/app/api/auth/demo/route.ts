import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { hashPassword, setSessionCookie } from "@/lib/auth";
import { audit, clientIp, rateLimit } from "@/lib/security";

export const runtime = "nodejs";

/**
 * POST /api/auth/demo — one-click demo workspace.
 *
 * Temporary convenience feature: signs the visitor into a shared, clearly
 * labeled demo account (creating it on first use). Demo data is real but the
 * account is marked isDemo so the UI can badge it.
 */
export async function POST(req: Request) {
  const ip = clientIp(req);
  const rl = rateLimit(`demo:${ip}`, 10, 15 * 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { ok: false, error: "Too many demo attempts — try again later" },
      { status: 429 }
    );
  }
  try {
    const email = "demo@area.platform";
    let user = await db.user.findUnique({ where: { email } });
    if (!user) {
      try {
        user = await db.user.create({
          data: {
            email,
            name: "Demo Analyst",
            passwordHash: hashPassword(`demo-${Date.now()}-${Math.random()}`),
            role: "demo",
            isDemo: true,
          },
        });
        await audit("auth.demo_created", { userId: user.id, ip });
      } catch (err) {
        // Concurrent first-use race on the shared demo account: re-read.
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2002"
        ) {
          const existing = await db.user.findUnique({ where: { email } });
          if (!existing) throw err;
          user = existing;
        } else {
          throw err;
        }
      }
    }
    await setSessionCookie(user.id, user.email, {
      ip,
      userAgent: req.headers.get("user-agent"),
    });
    await audit("auth.login", {
      userId: user.id,
      ip,
      detail: "method=demo",
    });
    return NextResponse.json({
      ok: true,
      user: { id: user.id, email: user.email, name: user.name, role: user.role, isDemo: true },
    });
  } catch (err) {
    console.error("demo login error:", err);
    return NextResponse.json({ ok: false, error: "Internal error" }, { status: 500 });
  }
}
