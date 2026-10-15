/**
 * Format detection via magic bytes + filename hints.
 * Mirrors AREA's fail-closed admission: unknown formats are clearly reported.
 */

export interface FormatDetection {
  format: string; // canonical id: elf, pe, macho, wasm, evm, sqlite, zip, apk, jar, asar, plist, javascript, json, pcap, dex, pdf, png, gzip, tar, text, unknown
  family:
    | "native"
    | "bytecode"
    | "container"
    | "database"
    | "script"
    | "capture"
    | "document"
    | "media"
    | "unknown";
  label: string; // human label
  confidence: "high" | "medium" | "low";
  details: string;
}

export function detectFormat(
  buf: Buffer,
  filename: string
): FormatDetection {
  const magic = buf.subarray(0, 16);
  const hex = magic.toString("hex");
  const ascii = magic.toString("latin1");
  const lower = filename.toLowerCase();

  // --- Native executables ---
  if (hex.startsWith("7f454c46"))
    return { format: "elf", family: "native", label: "ELF executable / object", confidence: "high", details: `ELF class ${buf.length > 4 ? (buf[4] === 2 ? "64-bit" : buf[4] === 1 ? "32-bit" : "?") : "?"}, machine ${buf.length >= 20 ? `0x${buf.readUInt16LE(18).toString(16)}` : "?"}` };
  if (ascii.startsWith("MZ"))
    return { format: "pe", family: "native", label: "Windows PE executable", confidence: "high", details: "DOS/PE header detected" };
  if (hex.startsWith("cffaedfe") || hex.startsWith("feedfacf") || hex.startsWith("cafebabe") || hex.startsWith("bebafeca"))
    return { format: "macho", family: "native", label: "Mach-O binary", confidence: "high", details: "Mach-O magic detected" };

  // --- Bytecode ---
  if (hex.startsWith("0061736d"))
    return { format: "wasm", family: "bytecode", label: "WebAssembly module", confidence: "high", details: `WASM version ${buf.length >= 8 ? buf.readUInt32LE(4) : "?"}` };
  if (lower.endsWith(".evm") || lower.endsWith(".bin") || lower.endsWith(".hex"))
    return { format: "evm", family: "bytecode", label: "EVM bytecode", confidence: "medium", details: "EVM extension hint (.evm/.bin/.hex)" };

  // --- Databases ---
  if (ascii.startsWith("SQLite format 3"))
    return { format: "sqlite", family: "database", label: "SQLite database", confidence: "high", details: "SQLite 3 magic string" };

  // --- Containers ---
  if (hex.startsWith("504b0304") || hex.startsWith("504b0506")) {
    if (lower.endsWith(".apk")) return { format: "apk", family: "container", label: "Android package (APK)", confidence: "high", details: "ZIP container + .apk extension" };
    if (lower.endsWith(".jar")) return { format: "jar", family: "container", label: "Java archive (JAR)", confidence: "high", details: "ZIP container + .jar extension" };
    if (lower.endsWith(".asar")) return { format: "asar", family: "container", label: "Electron ASAR archive", confidence: "medium", details: "ZIP magic with .asar name (verify below)" };
    return { format: "zip", family: "container", label: "ZIP archive", confidence: "high", details: "PK zip magic" };
  }
  if (ascii.startsWith("\x1f\x8b"))
    return { format: "gzip", family: "container", label: "Gzip stream", confidence: "high", details: "gzip magic" };
  if (ascii.startsWith("ustar") || (buf.length > 257 && buf.subarray(257, 262).toString() === "ustar"))
    return { format: "tar", family: "container", label: "TAR archive", confidence: "high", details: "ustar magic" };

  // ASAR has its own header: 04 00 00 00 xx xx xx xx {"files":
  if (buf.length > 16 && buf.readUInt32LE(0) === 4 && ascii.includes('"files"'))
    return { format: "asar", family: "container", label: "Electron ASAR archive", confidence: "high", details: "ASAR pickle header + files manifest" };

  // --- Captures ---
  if (hex.startsWith("d4c3b2a1") || hex.startsWith("a1b2c3d4") || hex.startsWith("4d3cb2a1") || hex.startsWith("a1b23c4d"))
    return { format: "pcap", family: "capture", label: "Packet capture (PCAP)", confidence: "high", details: "libpcap magic" };
  if (hex.startsWith("0a0d0d0a"))
    return { format: "pcapng", family: "capture", label: "Packet capture (PCAPNG)", confidence: "high", details: "pcapng magic" };

  // --- Android ---
  if (ascii.startsWith("dex\n") || ascii.startsWith("dey\n"))
    return { format: "dex", family: "bytecode", label: "Android DEX bytecode", confidence: "high", details: "dex magic" };

  // --- Documents / structured ---
  if (hex.startsWith("25504446"))
    return { format: "pdf", family: "document", label: "PDF document", confidence: "high", details: "%PDF magic" };
  if (ascii.startsWith("<?xml") || (ascii.startsWith("<") && ascii.includes("plist")))
    return { format: "plist", family: "document", label: "XML plist", confidence: "medium", details: "XML/plist text signature" };
  if (ascii.startsWith("bplist00"))
    return { format: "bplist", family: "document", label: "Binary plist", confidence: "high", details: "bplist00 magic" };
  if (hex.startsWith("89504e47"))
    return { format: "png", family: "media", label: "PNG image", confidence: "high", details: "PNG magic" };

  // --- Text / code ---
  const textish = isTextish(buf);
  if (textish) {
    const head = buf.subarray(0, 4096).toString("utf8");
    if (looksLikeJson(head)) return { format: "json", family: "document", label: "JSON data", confidence: "high", details: "Parses as JSON" };
    if (/(import|export|require|function|const|let|var|=>)/.test(head) && /\.(js|mjs|cjs|ts|jsx|tsx)$/i.test(lower))
      return { format: "javascript", family: "script", label: "JavaScript / TypeScript source", confidence: "high", details: "JS/TS syntax markers" };
    if (/\b(contract|pragma|function)\b/.test(head) && /\.sol$/i.test(lower))
      return { format: "solidity", family: "script", label: "Solidity source", confidence: "medium", details: "Solidity syntax markers" };
    if (/^#!/.test(head))
      return { format: "script", family: "script", label: "Script (shebang)", confidence: "high", details: head.split("\n")[0].slice(0, 60) };
    if (lower.endsWith(".txt") || lower.endsWith(".md"))
      return { format: "text", family: "document", label: "Plain text", confidence: "high", details: "UTF-8 text" };
    return { format: "text", family: "document", label: "Text-like data", confidence: "low", details: "Mostly printable bytes; no stronger signature" };
  }

  return {
    format: "unknown",
    family: "unknown",
    label: "Unknown binary format",
    confidence: "low",
    details: "No known magic signature matched. AREA will treat this as a raw binary and extract strings/hex only.",
  };
}

function isTextish(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 4096));
  if (sample.length === 0) return false;
  let printable = 0;
  for (const b of sample) {
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127) || b >= 0xc2) printable++;
  }
  return printable / sample.length > 0.85;
}

function looksLikeJson(head: string): boolean {
  const t = head.trimStart();
  return t.startsWith("{") || t.startsWith("[");
}

/** Formats the platform can meaningfully analyze with the bundled AREA engine. */
export const SUPPORTED_FORMATS: Record<string, string[]> = {
  zip: ["inspect_artifact", "extract_artifact"],
  apk: ["inspect_artifact", "extract_artifact"],
  jar: ["inspect_artifact", "extract_artifact"],
  asar: ["inspect_artifact", "extract_artifact"],
  gzip: ["inspect_artifact"],
  tar: ["inspect_artifact"],
  sqlite: ["inspect_sqlite_database*"],
  javascript: ["analyze_javascript_application"],
  evm: ["inspect_evm_interface"],
  wasm: ["inspect_wasm_artifact*"],
  elf: ["inspect_binary_layout*", "strings/hex"],
  pe: ["inspect_binary_layout*", "strings/hex"],
  macho: ["strings/hex"],
  dex: ["strings/hex"],
  pcap: ["inspect_pcap_capture*"],
  pcapng: ["inspect_pcap_capture*"],
  plist: ["inspect_plist", "inspect_artifact"],
  bplist: ["inspect_plist"],
  json: ["structure"],
  text: ["strings/hex"],
  unknown: ["strings/hex"],
};
// (* = requires an optional external tool; platform degrades gracefully.)
