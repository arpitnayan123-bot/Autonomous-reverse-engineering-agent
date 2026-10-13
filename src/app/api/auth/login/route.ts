import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { setSessionCookie, verifyPassword } from "@/lib/auth";
import { audit, clientIp, rateLimit } from "@/lib/security";

export const runtime = "nodejs";

/**
 * Constant-work dummy hash so "unknown email" and "wrong password" take the
 * same scrypt cost — otherwise response time is a user-enumeration oracle.
 */
const DUMMY_HASH = `scrypt$${"0".repeat(32)}$${"0".repeat(128)}`;

interface LoginBody {
  email?: unknown;
  password?: unknown;
}

export async function POST(req: Request) {
  try {
    const ip = clientIp(req);
    const limit = rateLimit(`login:${ip}`, 10, 15 * 60 * 1000);
    if (!limit.allowed) {
      await audit("auth.login_rate_limited", { ip, severity: "warn" });
      return NextResponse.json(
        {
          ok: false,
          error: `Too many login attempts. Try again in ${limit.retryAfterSec}s.`,
        },
        { status: 429 }
      );
    }

    const body = (await req.json().catch(() => null)) as LoginBody | null;
    const email =
      typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body?.password === "string" ? body.password : "";

    if (!email || !password) {
      return NextResponse.json(
        { ok: false, error: "Email and password are required" },
        { status: 400 }
      );
    }

    const user = await db.user.findUnique({ where: { email } });
    const ok = user ? verifyPassword(password, user.passwordHash) : verifyPassword(password, DUMMY_HASH);
    if (!user || !ok) {
      await audit("auth.login_failed", {
        detail: `invalid credentials for ${email}`,
        ip,
        severity: "warn",
      });
      return NextResponse.json(
        { ok: false, error: "Invalid email or password" },
        { status: 401 }
      );
    }

    await setSessionCookie(user.id, user.email);
    await audit("auth.login", {
      userId: user.id,
      detail: `login ${email}`,
      ip,
    });

    return NextResponse.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        isDemo: user.isDemo,
      },
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Login failed" },
      { status: 500 }
    );
  }
}
