import { headers } from "next/headers";

/**
 * Best-effort server-side title lookup for dynamic route metadata. Forwards
 * the incoming session cookie so the platform returns THIS user's record;
 * any failure degrades silently to the route's generic title.
 */
export async function fetchRouteTitle(
  apiPath: string,
  pick: (json: Record<string, unknown>) => string | null | undefined
): Promise<string | null> {
  try {
    const h = await headers();
    const cookie = h.get("cookie") ?? "";
    if (!cookie) return null;
    const host = h.get("host") ?? "localhost:3000";
    const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
    const res = await fetch(`${proto}://${host}${apiPath}`, {
      headers: { cookie },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const json = (await res.json()) as Record<string, unknown>;
    return pick(json) ?? null;
  } catch {
    return null;
  }
}

/** Clip a dynamic title to a sane tab length. */
export function clipTitle(text: string, max = 60): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
