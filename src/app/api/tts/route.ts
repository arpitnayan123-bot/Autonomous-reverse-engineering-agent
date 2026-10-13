import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { audit, clientIp, rateLimit } from "@/lib/security";

export const runtime = "nodejs";

/** Bounds for read-aloud requests (SDK hard limit is 1024 chars). */
const MIN_TEXT_CHARS = 1;
const MAX_TEXT_CHARS = 1000;
/** English-flavored voice for spoken analysis answers. */
const TTS_VOICE = "jam";
const TTS_SPEED = 1.0;

/**
 * POST /api/tts { text } — read-aloud for assistant messages.
 * Returns audio/mpeg bytes. The SDK is server-side only; the text is
 * pre-sanitized on the client (markdown stripped) and re-bounded here.
 */
export async function POST(req: Request) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const ip = clientIp(req);
    const rl = rateLimit(`tts:${user.id}:${ip}`, 10, 60_000);
    if (!rl.allowed) {
      return NextResponse.json(
        { ok: false, error: "Too many read-aloud requests — try again in a minute." },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
      );
    }

    const body = (await req.json().catch(() => null)) as { text?: unknown } | null;
    const raw = typeof body?.text === "string" ? body.text : "";
    // Collapse whitespace — TTS reads prosody, not layout.
    const text = raw.replace(/\s+/g, " ").trim();
    if (text.length < MIN_TEXT_CHARS) {
      return NextResponse.json({ ok: false, error: "Nothing to read aloud." }, { status: 400 });
    }
    if (text.length > MAX_TEXT_CHARS) {
      return NextResponse.json(
        { ok: false, error: `Read-aloud is capped at ${MAX_TEXT_CHARS} characters.` },
        { status: 400 }
      );
    }

    const { default: ZAI } = await import("z-ai-web-dev-sdk");
    const zai = await ZAI.create();
    const response = await zai.audio.tts.create({
      input: text,
      voice: TTS_VOICE,
      speed: TTS_SPEED,
      response_format: "wav",
      stream: false,
    });

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(new Uint8Array(arrayBuffer));
    if (buffer.length === 0) {
      return NextResponse.json({ ok: false, error: "Empty audio returned." }, { status: 502 });
    }

    void audit("tts.speak", {
      userId: user.id,
      detail: `chars=${text.length} bytes=${buffer.length}`,
      ip,
      severity: "info",
    });

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": "audio/wav",
        "Content-Length": String(buffer.length),
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("[api/tts]", error);
    return NextResponse.json(
      { ok: false, error: "Read-aloud is unavailable right now." },
      { status: 500 }
    );
  }
}
