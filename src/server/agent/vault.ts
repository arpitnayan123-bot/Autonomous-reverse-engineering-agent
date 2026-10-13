import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "crypto";
import { getRuntimeSecret } from "@/lib/runtime-secret";

/**
 * API-key vault — BYOK provider keys are encrypted at rest with AES-256-GCM.
 *
 * Security invariants:
 * - Plaintext keys NEVER leave the server: API responses only ever include
 *   `keyLast4`; logs and audit entries are scrubbed via scrubSecrets().
 * - The vault secret is provisioned at runtime (env → persisted random) —
 *   never hardcoded — and is stretched with scrypt.
 * - Ciphertext, IV and auth tag are stored separately in the database.
 */

function vaultSecret(): string {
  return getRuntimeSecret("REA_VAULT_SECRET", "vaultSecret");
}

let cachedKey: Buffer | null = null;

function vaultKey(): Buffer {
  if (!cachedKey) {
    cachedKey = scryptSync(vaultSecret(), "rea-vault-salt-v1", 32);
  }
  return cachedKey;
}

export interface SealedKey {
  cipher: string;
  iv: string;
  tag: string;
}

export function sealKey(plaintext: string): SealedKey {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", vaultKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    cipher: enc.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

export function openKey(sealed: SealedKey): string {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    vaultKey(),
    Buffer.from(sealed.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(sealed.cipher, "base64")),
    decipher.final(),
  ]);
  return dec.toString("utf8");
}

/** Mask a key for display: keep provider prefix + last 4 only. */
export function maskKey(key: string): string {
  const last4 = key.slice(-4);
  if (key.startsWith("sk-")) return `sk-…${last4}`;
  if (key.startsWith("AIza")) return `AIza…${last4}`;
  return `…${last4}`;
}

/**
 * Scrub anything that looks like a secret out of provider error strings
 * before they are stored or surfaced (defense in depth).
 */
export function scrubSecrets(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***")
    .replace(/AIza[A-Za-z0-9_-]{8,}/g, "AIza***")
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, "Bearer ***")
    .replace(/x-api-key[:\s]+[A-Za-z0-9._-]{8,}/gi, "x-api-key: ***")
    .replace(/key=[A-Za-z0-9._-]{8,}/gi, "key=***");
}

// --- Sealed header bundles (connector auth) -----------------------------------
//
// Sealing lives next to the vault primitives so any server module can use it
// without importing the connector registry (keeps the dependency graph
// acyclic — e.g. research.ts needs connector headers but must not import
// connectors.ts, which imports research.ts).

/** Seal a set of auth headers into a single JSON string for DB storage. */
export function sealHeaders(headers: Record<string, string>): string | null {
  const entries = Object.entries(headers).filter(([k, v]) => k && v);
  if (entries.length === 0) return null;
  const sealed: Array<{ name: string; sealed: SealedKey }> = entries.map(([name, value]) => ({
    name: name.toLowerCase(),
    sealed: sealKey(value),
  }));
  return JSON.stringify(sealed);
}

/** Open a sealed header bundle. Unopenable entries are skipped silently. */
export function openHeaders(sealedJson: string | null): Record<string, string> {
  if (!sealedJson) return {};
  try {
    const arr = JSON.parse(sealedJson) as Array<{ name: string; sealed: SealedKey }>;
    const out: Record<string, string> = {};
    for (const e of arr) {
      try {
        out[e.name] = openKey(e.sealed);
      } catch {
        /* skip unopenable */
      }
    }
    return out;
  } catch {
    return {};
  }
}
