import fs from "node:fs/promises";
import path from "node:path";

/**
 * Platform-local string extraction (independent of the REA engine).
 *
 * Extracts printable string runs from a buffer:
 *  - ASCII runs: bytes 0x20..0x7E plus tab (0x09)
 *  - UTF-16LE runs: printable byte followed by a 0x00 byte
 *
 * Shared by the analysis pipeline (caches results) and the
 * GET /api/targets/[id]/strings endpoint (serves from cache).
 */

export interface ExtractedString {
  value: string;
  offset: number;
  encoding: "ascii" | "utf16le";
}

export interface ExtractStringsOptions {
  /** Minimum run length to report (default 5, hard floor 2). */
  minLength?: number;
  /** Maximum number of strings to return (default 8000). */
  max?: number;
}

const isPrintableAscii = (b: number): boolean =>
  (b >= 0x20 && b <= 0x7e) || b === 0x09;

export function extractStrings(
  buf: Buffer,
  opts: ExtractStringsOptions = {}
): ExtractedString[] {
  const minLength = Math.max(2, opts.minLength ?? 5);
  const max = Math.max(1, opts.max ?? 8000);
  const out: ExtractedString[] = [];
  const n = buf.length;

  let aStart = -1;
  let aLen = 0;
  let uStart = -1;
  let uLen = 0;

  const flushAscii = () => {
    if (aLen >= minLength && aStart >= 0) {
      out.push({
        value: buf.toString("latin1", aStart, aStart + aLen),
        offset: aStart,
        encoding: "ascii",
      });
    }
    aStart = -1;
    aLen = 0;
  };
  const flushUtf16 = () => {
    if (uLen >= minLength && uStart >= 0) {
      out.push({
        value: buf.toString("utf16le", uStart, uStart + uLen * 2),
        offset: uStart,
        encoding: "utf16le",
      });
    }
    uStart = -1;
    uLen = 0;
  };

  for (let i = 0; i < n; i++) {
    const b = buf[i];

    // --- ASCII run tracking ---
    if (isPrintableAscii(b)) {
      if (aStart < 0) aStart = i;
      aLen++;
    } else {
      flushAscii();
    }

    // --- UTF-16LE run tracking (printable byte + 0x00 next) ---
    if (isPrintableAscii(b) && i + 1 < n && buf[i + 1] === 0x00) {
      if (uLen > 0 && uStart + uLen * 2 === i) {
        uLen++;
      } else {
        flushUtf16();
        uStart = i;
        uLen = 1;
      }
    } else {
      flushUtf16();
    }

    if (out.length >= max) break;
  }
  flushAscii();
  flushUtf16();

  return out;
}

// ---------------------------------------------------------------------------
// Strings cache (storage/uploads/<targetId>/strings-cache.json)
// ---------------------------------------------------------------------------

const STRINGS_CACHE_VERSION = 1;
const CACHED_VALUE_MAX_CHARS = 200;
const CACHED_ROWS_MAX = 8000;

export function stringsCachePath(targetId: string): string {
  return path.join(
    process.cwd(),
    "storage",
    "uploads",
    targetId,
    "strings-cache.json"
  );
}

function slimForCache(strings: ExtractedString[]): ExtractedString[] {
  return strings.slice(0, CACHED_ROWS_MAX).map((s) => ({
    offset: s.offset,
    value:
      s.value.length > CACHED_VALUE_MAX_CHARS
        ? `${s.value.slice(0, CACHED_VALUE_MAX_CHARS)}…`
        : s.value,
    encoding: s.encoding,
  }));
}

/** Atomic write of the strings cache; values truncated to keep file small. */
export async function writeStringsCache(
  targetId: string,
  strings: ExtractedString[],
  totalCount?: number
): Promise<void> {
  const file = stringsCachePath(targetId);
  const tmp = `${file}.${process.pid}.tmp`;
  const body = JSON.stringify({
    version: STRINGS_CACHE_VERSION,
    count: typeof totalCount === "number" ? totalCount : strings.length,
    strings: slimForCache(strings),
  });
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(tmp, body, "utf8");
  await fs.rename(tmp, file).catch(async () => {
    // rename can fail across odd fs states; fall back to direct write
    await fs.writeFile(file, body, "utf8");
  });
}

/** Read the cached strings; returns null when absent or corrupt. */
export async function readStringsCache(
  targetId: string
): Promise<ExtractedString[] | null> {
  try {
    const raw = await fs.readFile(stringsCachePath(targetId), "utf8");
    const parsed = JSON.parse(raw) as { strings?: unknown };
    if (!Array.isArray(parsed.strings)) return null;
    const strings: ExtractedString[] = [];
    for (const item of parsed.strings) {
      if (item && typeof item === "object") {
        const rec = item as Record<string, unknown>;
        if (typeof rec.value === "string" && typeof rec.offset === "number") {
          strings.push({
            value: rec.value,
            offset: rec.offset,
            encoding: rec.encoding === "utf16le" ? "utf16le" : "ascii",
          });
        }
      }
    }
    return strings;
  } catch {
    return null;
  }
}

/**
 * Get strings for a target: cache-first, otherwise extract from the file
 * at absPath and populate the cache. Used by pipeline + strings endpoint.
 */
export async function getStringsForTarget(
  targetId: string,
  absPath: string
): Promise<ExtractedString[]> {
  const cached = await readStringsCache(targetId);
  if (cached && cached.length > 0) return cached;
  const buf = await fs.readFile(absPath);
  const strings = extractStrings(buf, { minLength: 5, max: 8000 });
  await writeStringsCache(targetId, strings).catch(() => undefined);
  return strings;
}

/** Resolve a DB-stored relative path safely inside the project storage root. */
export function resolveStoragePath(storedPath: string): string | null {
  const storageRoot = path.join(process.cwd(), "storage");
  const resolved = path.resolve(process.cwd(), storedPath);
  if (resolved !== storageRoot && !resolved.startsWith(storageRoot + path.sep)) {
    return null;
  }
  return resolved;
}
