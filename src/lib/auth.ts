import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { db } from "./db";
import { getRuntimeSecret } from "./runtime-secret";

/**
 * Authentication for the REA platform.
 * - Passwords hashed with scrypt (node:crypto), per-user random salt.
 * - Sessions: HMAC-SHA256 signed payload stored in an HttpOnly cookie.
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
  exp: number;
}

function sign(data: string): string {
  return createHmac("sha256", sessionSecret()).update(data).digest("base64url");
}

export function createSessionToken(userId: string, email: string): string {
  const payload: SessionPayload = {
    sub: userId,
    email,
    exp: Date.now() + SESSION_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body)}`;
}

export function verifySessionToken(token: string): SessionPayload | null {
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
    if (!payload.sub || payload.exp < Date.now()) return null;
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

export async function getSessionUser(): Promise<AuthedUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const payload = verifySessionToken(token);
  if (!payload) return null;
  const user = await db.user.findUnique({
    where: { id: payload.sub },
    select: { id: true, email: true, name: true, role: true, isDemo: true },
  });
  return user ?? null;
}

export async function setSessionCookie(userId: string, email: string) {
  const store = await cookies();
  store.set(SESSION_COOKIE, createSessionToken(userId, email), {
    httpOnly: true,
    sameSite: "lax",
    // HTTPS only in production; the sandbox/dev server runs plain HTTP.
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_TTL_MS / 1000,
    path: "/",
  });
}

export async function clearSessionCookie() {
  const store = await cookies();
  store.set(SESSION_COOKIE, "", { httpOnly: true, maxAge: 0, path: "/" });
}

export function validateEmail(email: string): boolean {
  return typeof email === "string" && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function validatePassword(password: string): boolean {
  return typeof password === "string" && password.length >= 8 && password.length <= 200;
}
