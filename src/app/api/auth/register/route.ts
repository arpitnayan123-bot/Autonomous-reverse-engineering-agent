import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  hashPassword,
  setSessionCookie,
  validateEmail,
  validatePassword,
} from "@/lib/auth";
import { audit, clientIp, rateLimit } from "@/lib/security";

export const runtime = "nodejs";

interface RegisterBody {
  email?: unknown;
  password?: unknown;
  name?: unknown;
}

export async function POST(req: Request) {
  try {
    const ip = clientIp(req);
    const limit = rateLimit(`register:${ip}`, 5, 60 * 60 * 1000);
    if (!limit.allowed) {
      return NextResponse.json(
        {
          ok: false,
          error: `Too many registration attempts. Try again in ${limit.retryAfterSec}s.`,
        },
        { status: 429 }
      );
    }

    const body = (await req.json().catch(() => null)) as RegisterBody | null;
    if (!body) {
      return NextResponse.json(
        { ok: false, error: "Invalid JSON body" },
        { status: 400 }
      );
    }

    const email =
      typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const name =
      typeof body.name === "string" ? body.name.trim().slice(0, 100) : null;

    if (!validateEmail(email)) {
      return NextResponse.json(
        { ok: false, error: "Invalid email address" },
        { status: 400 }
      );
    }
    if (!validatePassword(password)) {
      return NextResponse.json(
        { ok: false, error: "Password must be 8-200 characters" },
        { status: 400 }
      );
    }

    const existing = await db.user.findUnique({ where: { email } });
    if (existing) {
      await audit("auth.register_rejected", {
        detail: `duplicate email: ${email}`,
        ip,
        severity: "warn",
      });
      return NextResponse.json(
        { ok: false, error: "Email already registered" },
        { status: 409 }
      );
    }

    let user: {
      id: string;
      email: string;
      name: string | null;
      role: string;
      isDemo: boolean;
      createdAt: Date;
    };
    try {
      user = await db.user.create({
        data: {
          email,
          name: name || null,
          passwordHash: hashPassword(password),
        },
        select: { id: true, email: true, name: true, role: true, isDemo: true, createdAt: true },
      });
    } catch (err) {
      // Concurrent first-use race: unique-constraint violation → 409, not 500.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        return NextResponse.json(
          { ok: false, error: "Email already registered" },
          { status: 409 }
        );
      }
      throw err;
    }

    await setSessionCookie(user.id, user.email, {
      ip,
      userAgent: req.headers.get("user-agent"),
    });
    await audit("auth.register", {
      userId: user.id,
      detail: `registered ${email}`,
      ip,
    });

    return NextResponse.json({ ok: true, user });
  } catch (err) {
    await audit("auth.register_error", {
      detail: err instanceof Error ? err.message : String(err),
      severity: "warn",
    });
    return NextResponse.json(
      { ok: false, error: "Registration failed" },
      { status: 500 }
    );
  }
}
