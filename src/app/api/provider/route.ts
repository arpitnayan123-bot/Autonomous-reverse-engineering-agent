import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { audit, clientIp, rateLimit } from "@/lib/security";
import {
  PROVIDERS,
  getProviderDef,
  resolveLlmForUser,
  verifyProviderKey,
} from "@/server/agent/providers";
import { maskKey, sealKey } from "@/server/agent/vault";
import type { ProviderId } from "@/server/agent/providers";

export const runtime = "nodejs";

/**
 * BYOK provider key management.
 * The plaintext key is NEVER returned to the client — only the masked tail.
 */

/** GET /api/provider — current provider config (masked) + catalog. */
export async function GET() {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const record = await db.providerKey.findUnique({ where: { userId: user.id } });
  return NextResponse.json({
    ok: true,
    providers: PROVIDERS.map((p) => ({
      id: p.id,
      label: p.label,
      vendor: p.vendor,
      docsHint: p.docsHint,
      models: p.models,
    })),
    active: record
      ? {
          provider: record.provider,
          model: record.model,
          keyMasked: maskKey(`xxxxxxxx${record.keyLast4}`),
          keyLast4: record.keyLast4,
          verified: record.verified,
          updatedAt: record.updatedAt,
        }
      : null,
  });
}

/** POST /api/provider — save (and verify) a provider key. */
export async function POST(req: Request) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    const rl = rateLimit(`provider:set:${user.id}`, 10, 60 * 60_000);
    if (!rl.allowed) {
      return NextResponse.json(
        { ok: false, error: "Rate limit exceeded" },
        { status: 429 }
      );
    }
    const body = (await req.json().catch(() => null)) as {
      provider?: unknown;
      apiKey?: unknown;
      model?: unknown;
      verify?: unknown;
    } | null;
    const providerId = typeof body?.provider === "string" ? body.provider : "";
    const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
    const model = typeof body?.model === "string" ? body.model.trim() : "";
    const doVerify = body?.verify !== false;

    const def = getProviderDef(providerId);
    if (!def) {
      return NextResponse.json(
        { ok: false, error: "Unknown provider" },
        { status: 400 }
      );
    }
    if (apiKey.length < 16 || apiKey.length > 400) {
      return NextResponse.json(
        { ok: false, error: "API key looks invalid (expected 16–400 characters)" },
        { status: 400 }
      );
    }
    if (!def.models.some((m) => m.id === model)) {
      return NextResponse.json(
        { ok: false, error: "Model is not offered by this provider" },
        { status: 400 }
      );
    }

    let verified = false;
    if (doVerify) {
      const v = await verifyProviderKey(providerId as ProviderId, apiKey, model);
      verified = v.ok;
      if (!v.ok) {
        await audit("provider.verify_failed", {
          userId: user.id,
          ip: clientIp(req),
          detail: `provider=${providerId} model=${model}`,
          severity: "warn",
        });
        return NextResponse.json(
          { ok: false, error: `Key verification failed: ${v.error}` },
          { status: 400 }
        );
      }
    }

    const sealed = sealKey(apiKey);
    const last4 = apiKey.slice(-4);
    await db.providerKey.upsert({
      where: { userId: user.id },
      update: {
        provider: providerId,
        model,
        keyCipher: sealed.cipher,
        keyIv: sealed.iv,
        keyTag: sealed.tag,
        keyLast4: last4,
        verified,
      },
      create: {
        userId: user.id,
        provider: providerId,
        model,
        keyCipher: sealed.cipher,
        keyIv: sealed.iv,
        keyTag: sealed.tag,
        keyLast4: last4,
        verified,
      },
    });
    await audit("provider.key_saved", {
      userId: user.id,
      ip: clientIp(req),
      detail: `provider=${providerId} model=${model} verified=${verified}`,
    });

    return NextResponse.json({
      ok: true,
      active: {
        provider: providerId,
        model,
        keyLast4: last4,
        verified,
      },
    });
  } catch (err) {
    console.error("provider POST error:", err);
    return NextResponse.json({ ok: false, error: "Internal error" }, { status: 500 });
  }
}

/** DELETE /api/provider — remove the stored key (falls back to platform model). */
export async function DELETE(req: Request) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  await db.providerKey.deleteMany({ where: { userId: user.id } });
  await audit("provider.key_removed", { userId: user.id, ip: clientIp(req) });
  return NextResponse.json({ ok: true });
}

/** Sanity ping of the currently stored key. Each ping costs a real LLM call. */
export async function PUT(req: Request) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const rl = rateLimit(`provider-ping:${user.id}`, 6, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { ok: false, error: "Too many verification pings — try again shortly", retryAfterSec: rl.retryAfterSec },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
    );
  }
  try {
    const llm = await resolveLlmForUser(user.id);
    const text = await llm.callLLM(
      [{ role: "user", content: "Reply with the single word: ok" }],
      { maxTokens: 16 }
    );
    return NextResponse.json({
      ok: true,
      source: llm.source,
      provider: llm.provider,
      model: llm.model,
      reply: text.trim().slice(0, 40),
    });
  } catch (err) {
    // Upstream failures are already scrubbed (vault.scrubSecrets) and are
    // genuinely useful here (quota/billing/key errors) — but cap the length
    // so stack noise / absolute paths can't leak.
    const msg = err instanceof Error ? err.message : "Model ping failed";
    return NextResponse.json(
      { ok: false, error: msg.slice(0, 300) },
      { status: 400 }
    );
  }
}
