import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { db } from "./db";
import { getRuntimeSecret } from "./runtime-secret";

/**
 * Authentication for the REA platform.
 * - Passwords hashed with scrypt (node:crypto), per-user random salt.
 * - Sessions: HMAC-SHA256 signed payload (carrying a server-side session id)
 *   stored in an HttpOnly cookie. Every request validates the session id
 *   against the AuthSession table, so logout — and "sign out other sessions" —
 *   revokes outstanding cookies immediately. The earlier stateless design kept
 *   a stolen token valid until expiry even after logout.
 * - The signing secret is provisioned at runtime (env → persisted random);
 *   it is never a hardcoded value.
 */

const SESSION_COOKIE = "rea_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

function sessionSecret(): string {
  return getRuntimeSecret("REA_SESSION_SECRET", "sessionSecret");
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, salt, hash] = stored.split("$");
    if (scheme !== "scrypt" || !salt || !hash) return false;
    const candidate = scryptSync(password, salt, 64);
    const expected = Buffer.from(hash, "hex");
    return (
      candidate.length === expected.length && timingSafeEqual(candidate, expected)
    );
  } catch {
    return false;
  }
}

interface SessionPayload {
  sub: string;
  email: string;
  /** Server-side AuthSession id — the revocation handle. */
  sid: string;
  exp: number;
}

function sign(data: string): string {
  return createHmac("sha256", sessionSecret()).update(data).digest("base64url");
}

function createSessionToken(userId: string, email: string, sid: string): string {
  const payload: SessionPayload = {
    sub: userId,
    email,
    sid,
    exp: Date.now() + SESSION_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body)}`;
}

function verifySessionToken(token: string): SessionPayload | null {
  try {
    const [body, sig] = token.split(".");
    if (!body || !sig) return null;
    const expected = sign(body);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8")
    ) as SessionPayload;
    if (!payload.sub || !payload.sid || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export interface AuthedUser {
  id: string;
  email: string;
  name: string | null;
  role: string;
  isDemo?: boolean;
}

/**
 * Create the server-side session record, then set the cookie that references
 * it. Called by login / register / demo sign-in.
 */
export async function setSessionCookie(
  userId: string,
  email: string,
  meta?: { ip?: string; userAgent?: string | null }
) {
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const session = await db.authSession.create({
    data: {
      userId,
      expiresAt,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ? meta.userAgent.slice(0, 300) : null,
    },
    select: { id: true },
  });
  const store = await cookies();
  store.set(SESSION_COOKIE, createSessionToken(userId, email, session.id), {
    httpOnly: true,
    sameSite: "lax",
    // HTTPS only in production; the sandbox/dev server runs plain HTTP.
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_TTL_MS / 1000,
    path: "/",
  });
}

/** Verify the cookie and return both the user and the live session id.
 *
 * Sliding renewal: when a live session is inside its final third of validity,
 * the row's expiry is extended server-side and the cookie is re-issued with a
 * fresh payload — an actively-used account no longer gets logged out mid-work
 * after 7 fixed days, while abandoned sessions still expire on schedule.
 * (Only ever called from route handlers, where cookie mutation is allowed.)
 */
async function resolveSession(): Promise<{
  payload: SessionPayload;
  user: AuthedUser;
} | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const payload = verifySessionToken(token);
  if (!payload) return null;
  const session = await db.authSession
    .findUnique({ where: { id: payload.sid } })
    .catch(() => null);
  if (
    !session ||
    session.revokedAt !== null ||
    session.expiresAt.getTime() <= Date.now() ||
    session.userId !== payload.sub
  ) {
    return null;
  }
  const user = await db.user.findUnique({
    where: { id: payload.sub },
    select: { id: true, email: true, name: true, role: true, isDemo: true },
  });
  if (!user) return null;

  try {
    const remaining = session.expiresAt.getTime() - Date.now();
    if (remaining < SESSION_TTL_MS / 3) {
      const newExpiry = new Date(Date.now() + SESSION_TTL_MS);
      await db.authSession.update({
        where: { id: session.id },
        data: { expiresAt: newExpiry },
      });
      // Re-issue the cookie so the client-side maxAge matches the extended
      // server row (same sid — the revocation handle is stable).
      store.set(
        SESSION_COOKIE,
        createSessionToken(user.id, user.email, session.id),
        {
          httpOnly: true,
          sameSite: "lax",
          secure: process.env.NODE_ENV === "production",
          maxAge: SESSION_TTL_MS / 1000,
          path: "/",
        }
      );
    }
  } catch {
    /* renewal is best-effort — the session stays valid either way */
  }

  return { payload, user };
}

export async function getSessionUser(): Promise<AuthedUser | null> {
  return (await resolveSession())?.user ?? null;
}

export async function clearSessionCookie() {
  const store = await cookies();
  store.set(SESSION_COOKIE, "", { httpOnly: true, maxAge: 0, path: "/" });
}

/** Revoke the session referenced by the current request's cookie (logout). */
export async function revokeCurrentSession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  const payload = token ? verifySessionToken(token) : null;
  if (payload) {
    await db.authSession
      .update({
        where: { id: payload.sid },
        data: { revokedAt: new Date() },
      })
      .catch(() => undefined);
  }
}

/** Revoke every live session of the user EXCEPT the current one. */
export async function revokeOtherSessions(userId: string): Promise<number> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  const payload = token ? verifySessionToken(token) : null;
  const res = await db.authSession.updateMany({
    where: {
      userId,
      revokedAt: null,
      expiresAt: { gt: new Date() },
      ...(payload ? { id: { not: payload.sid } } : {}),
    },
    data: { revokedAt: new Date() },
  });
  return res.count;
}

export interface ActiveAuthSession {
  id: string;
  createdAt: string;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

/** Live (unrevoked, unexpired) sessions for the security view. */
export async function listActiveSessions(userId: string): Promise<ActiveAuthSession[]> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  const payload = token ? verifySessionToken(token) : null;
  const rows = await db.authSession.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  return rows.map((s) => ({
    id: s.id,
    createdAt: s.createdAt.toISOString(),
    ip: s.ip,
    userAgent: s.userAgent,
    current: s.id === payload?.sid,
  }));
}

/** Housekeeping: drop this user's expired/revoked session rows older than 30 days. */
export async function purgeStaleSessions(userId?: string): Promise<void> {
  const cutoff = new Date(Date.now() - 1000 * 60 * 60 * 24 * 30);
  try {
    await db.authSession.deleteMany({
      where: {
        ...(userId ? { userId } : {}),
        OR: [
          { expiresAt: { lt: cutoff } },
          { revokedAt: { lt: cutoff } },
        ],
      },
    });
  } catch {
    /* housekeeping must never break the request */
  }
}

export function validateEmail(email: string): boolean {
  return typeof email === "string" && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function validatePassword(password: string): boolean {
  return typeof password === "string" && password.length >= 8 && password.length <= 200;
}
