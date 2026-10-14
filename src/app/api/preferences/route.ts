import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { audit, clientIp, rateLimit } from "@/lib/security";
import {
  SANDBOX_MODES,
  containerRuntimeBin,
  detectDocker,
  getUserSandboxMode,
  isSandboxMode,
  sandboxImage,
  setUserSandboxMode,
} from "@/server/platform/sandbox";

export const runtime = "nodejs";

/**
 * Per-user platform preferences — security-scoped like /api/security and
 * /api/memory: reads and writes are keyed to the SESSION user only; there is
 * no way to address another account's preferences.
 *
 * GET   /api/preferences → { ok, sandboxMode, docker: { available, runtime, image }, modes }
 * PATCH /api/preferences { sandboxMode: "auto" | "process" | "docker" }
 *
 * `sandboxMode` selects where chat-workspace commands execute (see
 * sandbox.ts). It is a preference, not a security bypass — the command
 * allowlist and chat guards apply identically in every mode.
 */
export async function GET() {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    const [sandboxMode, dockerAvailable] = await Promise.all([
      getUserSandboxMode(user.id),
      detectDocker(),
    ]);
    const runtimeBin = dockerAvailable ? await containerRuntimeBin() : null;
    return NextResponse.json({
      ok: true,
      sandboxMode,
      docker: {
        available: dockerAvailable,
        runtime: runtimeBin,
        image: sandboxImage(),
      },
      modes: SANDBOX_MODES,
    });
  } catch (err) {
    console.error("preferences GET error:", err);
    return NextResponse.json({ ok: false, error: "Internal error" }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    const limit = rateLimit(`preferences-update:${user.id}`, 30, 5 * 60 * 1000);
    if (!limit.allowed) {
      return NextResponse.json(
        { ok: false, error: `Too many preference updates — retry in ${limit.retryAfterSec}s.` },
        { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } }
      );
    }
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ ok: false, error: "Request body must be JSON" }, { status: 400 });
    }
    const mode = (body as { sandboxMode?: unknown } | null)?.sandboxMode;
    if (!isSandboxMode(mode)) {
      return NextResponse.json(
        { ok: false, error: `sandboxMode must be one of: ${SANDBOX_MODES.join(", ")}` },
        { status: 400 }
      );
    }
    await setUserSandboxMode(user.id, mode);
    await audit("preferences.sandbox", {
      userId: user.id,
      ip: clientIp(req),
      detail: `sandboxMode=${mode}`,
    });
    return NextResponse.json({ ok: true, sandboxMode: mode });
  } catch (err) {
    console.error("preferences PATCH error:", err);
    return NextResponse.json({ ok: false, error: "Internal error" }, { status: 500 });
  }
}
