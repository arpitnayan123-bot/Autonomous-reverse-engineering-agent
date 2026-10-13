import { randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";

/**
 * Runtime secret resolution for secrets that MUST NOT ship in source.
 *
 * Priority:
 *  1. Environment variable (REA_SESSION_SECRET / REA_VAULT_SECRET) — for
 *     real deployments that provision secrets properly.
 *  2. A previously generated secret persisted under db/.secrets.json
 *     (gitignored, 0600) so restarts keep sessions/vault stable.
 *  3. Generate a cryptographically random secret and persist it.
 *
 * This replaces the previous hardcoded fallback strings, which were live in
 * this deployment (anyone with repo read access could forge sessions and
 * decrypt sealed provider keys).
 */

const SECRET_FILE = path.join(process.cwd(), "db", ".secrets.json");

interface SecretFile {
  sessionSecret?: string;
  vaultSecret?: string;
}

function readSecretFile(): SecretFile {
  try {
    if (!existsSync(SECRET_FILE)) return {};
    return JSON.parse(readFileSync(SECRET_FILE, "utf8")) as SecretFile;
  } catch {
    return {};
  }
}

function writeSecretFile(update: SecretFile): void {
  try {
    mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
    const current = readSecretFile();
    const merged = { ...current, ...update };
    writeFileSync(SECRET_FILE, JSON.stringify(merged), { mode: 0o600 });
  } catch {
    /* best effort — worst case the secret regenerates on restart */
  }
}

const cache = new Map<string, string>();

/**
 * Resolve a named runtime secret. `envVar` is checked first; otherwise the
 * persisted file is consulted/generated. `fileKey` is the JSON field name.
 */
export function getRuntimeSecret(envVar: string, fileKey: string): string {
  const fromEnv = process.env[envVar];
  if (fromEnv && fromEnv.length >= 16) return fromEnv;

  const cached = cache.get(fileKey);
  if (cached) return cached;

  const fromFile = readSecretFile()[fileKey];
  if (fromFile && fromFile.length >= 16) {
    cache.set(fileKey, fromFile);
    return fromFile;
  }

  const generated = randomBytes(32).toString("hex");
  cache.set(fileKey, generated);
  writeSecretFile({ [fileKey]: generated });
  return generated;
}
