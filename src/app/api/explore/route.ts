import { NextResponse } from "next/server";
import { clientIp, rateLimit } from "@/lib/security";
import { getSessionUser } from "@/lib/auth";
import { unauthorized, badRequest } from "@/server/platform/api-helpers";
import { probeUrl } from "@/server/platform/explorer";
import { BlockedUrlError } from "@/server/platform/net";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/explore — single-page URL probe over the shared SSRF-guarded
 * extraction pipeline (probeUrl). No project required, no database writes.
 * Returns the observed facts: requested/final URL, status, timing,
 * content-type, sha256, title, description, headings, links, technologies
 * and a bounded text excerpt. Refused URLs (SSRF guard) return 400 with the
 * honest reason; network/DNS failures return 502 with the real message.
 *
 * Body: { url: string, includeText?: boolean }
 */
export async function POST(req: Request) {
  try {
    const user = await getSessionUser();
    if (!user) return unauthorized();

    const ip = clientIp(req);
    const limit = rateLimit(`explore:${user.id}`, 30, 10 * 60 * 1000);
    if (!limit.allowed) {
      return NextResponse.json(
        { ok: false, error: `Explore rate limit reached. Try again in ${limit.retryAfterSec}s.` },
        { status: 429 }
      );
    }

    const body = (await req.json().catch(() => ({}))) as { url?: string; includeText?: boolean };
    const url = typeof body.url === "string" ? body.url.trim() : "";
    if (!url) return badRequest("url is required");
    if (url.length > 2000) return badRequest("url too long (max 2000 chars)");

    const result = await probeUrl(url, { includeText: body.includeText !== false });
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    if (err instanceof BlockedUrlError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: 400 });
    }
    if (err instanceof Error && err.name === "TimeoutError") {
      return NextResponse.json(
        { ok: false, error: "Fetch timed out — the target did not respond within the probe budget." },
        { status: 504 }
      );
    }
    console.error("explore error:", err);
    const detail = err instanceof Error ? err.message : "fetch failed";
    return NextResponse.json({ ok: false, error: `Probe failed: ${detail}` }, { status: 502 });
  }
}
