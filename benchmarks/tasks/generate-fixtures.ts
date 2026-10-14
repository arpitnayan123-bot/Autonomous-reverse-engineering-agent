#!/usr/bin/env bun
/**
 * Deterministic fixture + task.toml generator for the REA benchmark suite.
 *
 * Every fixture below is crafted (not random) so that:
 *  - the encoded/hidden values the rubrics check are computed HERE from the
 *    same constants the rubric names (rubric and fixture can never drift);
 *  - re-running the generator reproduces byte-identical fixtures;
 *  - all fixtures are tiny (< 8 KB, far below the 1 MB budget).
 *
 * Run:  bun benchmarks/tasks/generate-fixtures.ts
 */
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const TASKS_ROOT = import.meta.dir;

// ---------------------------------------------------------------------------
// Small byte helpers
// ---------------------------------------------------------------------------

const enc = (s: string) => Buffer.from(s, "utf8");

function xorBuf(data: Buffer, key: number): Buffer {
  return Buffer.from(data.map((b) => b ^ key));
}

/** Minimal but REAL ELF64 little-endian executable header + one PT_LOAD. */
function elf64(opts: { entry?: number; extraStrings?: string[]; joinStrings?: Buffer[] }): Buffer {
  const parts: Buffer[] = [];
  const h = Buffer.alloc(64);
  h.set([0x7f, 0x45, 0x4c, 0x46], 0); // ELF magic
  h.set([0x02, 0x01, 0x01, 0x00], 4); // 64-bit, little-endian, v1, SYSV
  h.writeUInt16LE(2, 16); // e_type = ET_EXEC
  h.writeUInt16LE(0x3e, 18); // e_machine = x86-64
  h.writeUInt32LE(1, 20); // e_version
  h.writeBigUInt64LE(BigInt(opts.entry ?? 0x00400000), 24); // e_entry
  h.writeBigUInt64LE(BigInt(64), 32); // e_phoff
  h.writeUInt32LE(0, 40); // e_flags
  h.writeUInt16LE(64, 42); // e_ehsize
  h.writeUInt16LE(56, 44); // e_phentsize
  h.writeUInt16LE(1, 46); // e_phnum
  h.writeUInt16LE(64, 48); // e_shentsize
  h.writeUInt16LE(0, 50); // e_shnum
  parts.push(h);
  const ph = Buffer.alloc(56);
  ph.writeUInt32LE(1, 0); // PT_LOAD
  ph.writeUInt32LE(5, 4); // R+X
  ph.writeBigUInt64LE(BigInt(0), 8); // offset
  ph.writeBigUInt64LE(BigInt(opts.entry ?? 0x00400000), 16); // vaddr
  parts.push(ph);
  // A code-ish page so hex dumps show more than a header.
  const code = Buffer.alloc(0x80, 0x90);
  code.set([0x55, 0x48, 0x89, 0xe5, 0x5d, 0xc3], 0); // push rbp; mov; pop; ret
  parts.push(code);
  for (const s of opts.extraStrings ?? []) parts.push(enc(`${s}\x00`));
  for (const b of opts.joinStrings ?? []) parts.push(b);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// task.toml emitter
// ---------------------------------------------------------------------------

function tomlStr(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

interface RubricItem {
  criterion: string;
  weight: number;
}

interface TaskSpec {
  id: string;
  category: "binary" | "web" | "code" | "mixed";
  difficulty: "easy" | "medium" | "hard";
  prompt: string;
  fixtureName: string;
  fixture: Buffer;
  timeout_ms: number;
  scoring:
    | { type: "rubric"; rubric: RubricItem[] }
    | { type: "exact"; expected: string }
    | { type: "human"; rubric: RubricItem[] };
}

const tasks: TaskSpec[] = [];
function task(t: TaskSpec): void {
  tasks.push(t);
}

function emitTask(t: TaskSpec): void {
  const dir = path.join(TASKS_ROOT, t.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, t.fixtureName), t.fixture);
  const lines: string[] = [];
  lines.push("[task]");
  lines.push(`id = ${tomlStr(t.id)}`);
  lines.push(`category = ${tomlStr(t.category)}`);
  lines.push(`difficulty = ${tomlStr(t.difficulty)}`);
  lines.push(`prompt = ${tomlStr(t.prompt)}`);
  lines.push(`fixture = ${tomlStr(`./${t.fixtureName}`)}`);
  lines.push(`timeout_ms = ${t.timeout_ms}`);
  lines.push("");
  lines.push("[scoring]");
  if (t.scoring.type === "exact") {
    lines.push(`type = "exact"`);
    lines.push(`expected = ${tomlStr(t.scoring.expected)}`);
  } else {
    lines.push(`type = ${tomlStr(t.scoring.type)}`);
    if ("rubric" in t.scoring) {
      lines.push("rubric = [");
      for (const r of t.scoring.rubric) {
        lines.push(`  { criterion = ${tomlStr(r.criterion)}, weight = ${r.weight} },`);
      }
      lines.push("]");
    }
  }
  lines.push("");
  writeFileSync(path.join(dir, "task.toml"), lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Constant knowledge baked into fixtures (real algorithm tables)
// ---------------------------------------------------------------------------

// First 32 bytes of the AES S-box + Rcon — instantly recognizable to anyone
// who knows AES, deliberately NOT named by any string in the fixture.
const AES_SBOX_32 = [
  0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
  0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
];
const AES_RCON = [0x8d, 0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];

// SHA-256 initial hash values (big-endian) + first 8 round constants.
const SHA256_IV = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
const SHA256_K8 = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5];

function wordsBE(words: number[]): Buffer {
  const out = Buffer.alloc(words.length * 4);
  words.forEach((w, i) => out.writeUInt32BE(w >>> 0, i * 4));
  return out;
}

// ---------------------------------------------------------------------------
// BINARY tasks (5)
// ---------------------------------------------------------------------------

// binary-analysis-001 — recognize AES from the S-box (no algorithm name string).
{
  const fixture = elf64({
    extraStrings: ["authmodule v1.2.0", "authenticate", "derive_key", "key_schedule", "block_cipher_init", "pkcs7_pad"],
    joinStrings: [Buffer.from(AES_SBOX_32), Buffer.from(AES_RCON)],
  });
  task({
    id: "binary-analysis-001",
    category: "binary",
    difficulty: "easy",
    prompt:
      "Analyze the uploaded binary and identify the encryption algorithm used by the authenticate function. " +
      "Name the algorithm and key size, point to the concrete evidence in the file (constants/tables and where they sit), " +
      "and describe what the key-schedule helper does. Follow the house evidence-grading rules (OBSERVED / DERIVED / INFERRED / UNKNOWN).",
    fixtureName: "auth-module.bin",
    fixture,
    timeout_ms: 240_000,
    scoring: {
      type: "rubric",
      rubric: [
        { criterion: "Identifies AES-128 (from the S-box/Rcon tables)", weight: 40 },
        { criterion: "Locates/derives the key-schedule (key derivation) helper and explains it", weight: 30 },
        { criterion: "Cites concrete file evidence with OBSERVED grade", weight: 30 },
      ],
    },
  });
}

// binary-analysis-002 — format / architecture / endianness triage.
{
  const fixture = elf64({
    extraStrings: [".text", ".rodata", "FWVER=2.3.1-buildroot", "console=ttyS0,115200"],
  });
  task({
    id: "binary-analysis-002",
    category: "binary",
    difficulty: "easy",
    prompt:
      "Triage the uploaded firmware image: state the container/executable format, the target architecture, and the byte order. " +
      "Show the header fields that prove each answer (offsets welcome), then list any version or configuration strings you can recover. " +
      "Grade every claim (OBSERVED / DERIVED / INFERRED / UNKNOWN).",
    fixtureName: "firmware-header.bin",
    fixture,
    timeout_ms: 240_000,
    scoring: {
      type: "rubric",
      rubric: [
        { criterion: "Identifies the format as ELF (executable, 64-bit class)", weight: 35 },
        { criterion: "Identifies x86-64 as the target architecture", weight: 35 },
        { criterion: "Identifies little-endian byte order and cites header evidence", weight: 30 },
      ],
    },
  });
}

// binary-analysis-003 — recognize SHA-256 from its IV/round constants.
{
  const fixture = elf64({
    extraStrings: ["integrity-checker v0.9", "verify_integrity", "digest_ready", "chunk_processor"],
    joinStrings: [wordsBE(SHA256_IV), wordsBE(SHA256_K8)],
  });
  task({
    id: "binary-analysis-003",
    category: "binary",
    difficulty: "medium",
    prompt:
      "The uploaded binary computes an integrity digest over file chunks. Identify the hash algorithm used. " +
      "No algorithm-name string appears in the file — you must recognize the constant tables. Cite the exact constants you matched " +
      "and explain what they are. Grade every claim (OBSERVED / DERIVED / INFERRED / UNKNOWN).",
    fixtureName: "integrity-check.bin",
    fixture,
    timeout_ms: 300_000,
    scoring: {
      type: "rubric",
      rubric: [
        { criterion: "Identifies SHA-256 as the hash algorithm", weight: 50 },
        { criterion: "Cites the SHA-256 IV and/or round constants (hex) as the matching evidence", weight: 30 },
        { criterion: "Explains where in the binary the constants sit (context/offset)", weight: 20 },
      ],
    },
  });
}

// binary-analysis-004 — hardcoded secrets + endpoint harvest (security audit).
{
  const fixture = elf64({
    extraStrings: [
      "service-agent v4.1.7",
      "svc_backup",
      "Summer2024!",
      "API_KEY=sk-live-9f8e7d6c5b4a3210",
      "mgmt.internal.corp:8443",
      "telemetry.internal.corp:9090",
      "heartbeat_interval=30",
      "retry_max=5",
      "upload_diagnostics",
    ],
  });
  task({
    id: "binary-analysis-004",
    category: "binary",
    difficulty: "medium",
    prompt:
      "You are doing a pre-release security audit of the uploaded service agent binary. Recover: (1) any hardcoded credentials " +
      "(usernames, passwords, API keys) exactly as embedded, (2) every internal network endpoint (host:port) the agent contacts, " +
      "and (3) a short list of the exposure risks these create. Quote the strings and grade each finding " +
      "(OBSERVED / DERIVED / INFERRED / UNKNOWN).",
    fixtureName: "service-agent.bin",
    fixture,
    timeout_ms: 300_000,
    scoring: {
      type: "rubric",
      rubric: [
        { criterion: "Recovers the hardcoded credential pair (svc_backup / Summer2024!)", weight: 30 },
        { criterion: "Recovers the API key sk-live-9f8e7d6c5b4a3210", weight: 20 },
        { criterion: "Lists both internal endpoints (mgmt.internal.corp:8443, telemetry.internal.corp:9090)", weight: 25 },
        { criterion: "Flags the credential/API-key exposure as a security risk", weight: 25 },
      ],
    },
  });
}

// binary-analysis-005 — single-byte XOR config blob (agent should brute-force/decode).
{
  const XOR_KEY_005 = 0x5a;
  const PLAINTEXT_005 = "https://updates.example.com/beacon";
  const fixture = elf64({
    extraStrings: ["beacon_cfg v2", "CONFIG_BLOB:", "cfg_len=34", "single_byte_key"],
    joinStrings: [xorBuf(enc(PLAINTEXT_005), XOR_KEY_005)],
  });
  task({
    id: "binary-analysis-005",
    category: "binary",
    difficulty: "hard",
    prompt:
      "The uploaded binary carries an obfuscated configuration value: the bytes right after the 'CONFIG_BLOB:' marker are a " +
      "plain single-byte-XOR encoded ASCII string. Identify the XOR key, decode the full configuration string, and state the " +
      "method you used (brute force, frequency analysis, or known-plaintext). Writing a tiny decoder script in the workspace is " +
      "encouraged. Grade every claim (OBSERVED / DERIVED / INFERRED / UNKNOWN).",
    fixtureName: "beacon-config.bin",
    fixture,
    timeout_ms: 420_000,
    scoring: {
      type: "rubric",
      rubric: [
        { criterion: "Identifies the XOR key 0x5A", weight: 35 },
        { criterion: "Decodes the full endpoint https://updates.example.com/beacon", weight: 40 },
        { criterion: "Explains the decoding method (or shows the decoder script/output)", weight: 25 },
      ],
    },
  });
}

// ---------------------------------------------------------------------------
// WEB tasks (5) — all anchored on https://example.com (mandated safe host)
// ---------------------------------------------------------------------------

function reconTargetFile(notes: string): Buffer {
  return enc(
    [
      "# REA benchmark recon target",
      "url = https://example.com",
      "scope = public fetch only (no brute force, no login attempts)",
      ...notes.split("\n").map((n) => `notes = ${n}`),
      "",
    ].join("\n")
  );
}

// web-recon-001 — page identity (exact scoring: the title must appear).
task({
  id: "web-recon-001",
  category: "web",
  difficulty: "easy",
  prompt:
    "Fetch https://example.com with the URL explorer and report the page's identity: HTTP status, exact page title, " +
    "and the main heading. Keep it factual and grade each claim (OBSERVED / DERIVED / INFERRED / UNKNOWN).",
  fixtureName: "recon-target.txt",
  fixture: reconTargetFile("report page identity (status, title, heading)"),
  timeout_ms: 240_000,
  scoring: { type: "exact", expected: "Example Domain" },
});

// web-recon-002 — outbound link enumeration.
task({
  id: "web-recon-002",
  category: "web",
  difficulty: "easy",
  prompt:
    "Perform light recon on https://example.com: fetch it and enumerate EVERY outbound link on the page (href + anchor text). " +
    "State the total count of links captured. Grade each claim (OBSERVED / DERIVED / INFERRED / UNKNOWN).",
  fixtureName: "recon-target.txt",
  fixture: reconTargetFile("enumerate all outbound links"),
  timeout_ms: 240_000,
  scoring: {
    type: "rubric",
    rubric: [
      { criterion: "Identifies the single outbound link https://www.iana.org/domains/example", weight: 50 },
      { criterion: "Reports the anchor text (More information...) and the link count (1)", weight: 30 },
      { criterion: "Result comes from a real fetch (OBSERVED), not memory", weight: 20 },
    ],
  },
});

// web-recon-003 — structure + honestly-absent observables.
task({
  id: "web-recon-003",
  category: "web",
  difficulty: "medium",
  prompt:
    "Fetch https://example.com and produce a structural profile: page title, every heading (h1-h3) with its text, whether a " +
    "meta description exists, and any technology fingerprints detected. Explicitly state which expected observables were ABSENT " +
    "(an honest 'none found' is a result). Grade each claim (OBSERVED / DERIVED / INFERRED / UNKNOWN).",
  fixtureName: "recon-target.txt",
  fixture: reconTargetFile("structural profile incl. absent observables"),
  timeout_ms: 300_000,
  scoring: {
    type: "rubric",
    rubric: [
      { criterion: "Reports the h1 'Example Domain' and no h2/h3 headings", weight: 35 },
      { criterion: "Correctly states there is no meta description (absence handled honestly)", weight: 25 },
      { criterion: "Reports technology fingerprints (or their absence) as observed", weight: 20 },
      { criterion: "Provenance grading present and correctly applied", weight: 20 },
    ],
  },
});

// web-recon-004 — two-source reconciliation.
task({
  id: "web-recon-004",
  category: "web",
  difficulty: "medium",
  prompt:
    "Recon https://example.com using TWO independent sources: (1) a live fetch via the URL explorer, and (2) background " +
    "knowledge from the web-research tool (search for what example.com is reserved for). Then reconcile: what does the LIVE page " +
    "show today, what does the indexed knowledge claim, and where do they agree or differ? Grade each claim " +
    "(OBSERVED / DERIVED / INFERRED / UNKNOWN).",
  fixtureName: "recon-target.txt",
  fixture: reconTargetFile("two-source reconciliation"),
  timeout_ms: 300_000,
  scoring: {
    type: "rubric",
    rubric: [
      { criterion: "Uses BOTH explore_url (live fetch) and web_research (background)", weight: 40 },
      { criterion: "Accurately reports the live page content", weight: 30 },
      { criterion: "Explicitly reconciles live observation vs indexed knowledge", weight: 30 },
    ],
  },
});

// web-recon-005 — structured dossier with provenance discipline.
task({
  id: "web-recon-005",
  category: "web",
  difficulty: "hard",
  prompt:
    "Produce a compact OSINT dossier for the domain example.com: (1) what the domain is and who reserves it, (2) what the live " +
    "page currently serves (fetch it), (3) which RFC reserves example.com and related documentation/example domains, and " +
    "(4) a provenance table splitting OBSERVED facts (fetched) from DERIVED/INFERRED context (documented elsewhere). " +
    "Cite sources for every non-OBSERVED claim.",
  fixtureName: "recon-target.txt",
  fixture: reconTargetFile("domain dossier with provenance table"),
  timeout_ms: 420_000,
  scoring: {
    type: "rubric",
    rubric: [
      { criterion: "Covers identity + reservation status of example.com (IANA-reserved)", weight: 30 },
      { criterion: "Reports the live page from a real fetch", weight: 25 },
      { criterion: "Names the reserving RFC (2606, and/or 6761) via web research", weight: 25 },
      { criterion: "Separates OBSERVED from DERIVED/INFERRED with citations", weight: 20 },
    ],
  },
});

// ---------------------------------------------------------------------------
// CODE tasks (5)
// ---------------------------------------------------------------------------

// code-reconstruction-001 — Python auth handler (base64 + XOR + constant-time compare).
{
  const XOR_KEY_001 = 0x42;
  const SECRET_001 = "s3cr3t-harbor";
  const stored = Buffer.from(enc(SECRET_001).map((b) => b ^ XOR_KEY_001)).toString("base64");
  const fixture = enc(
    `# auth_handler.py — recovered from an internal service
import base64

# credential blob shipped with the agent build
STORED = "${stored}"
XOR_KEY = 0x42

def _decode(stored: str) -> bytes:
    raw = base64.b64decode(stored)
    return bytes(b ^ XOR_KEY for b in raw)

def authenticate(user: str, supplied: str) -> bool:
    expected = _decode(STORED)
    got = supplied.encode("utf-8")
    if len(got) != len(expected):
        return False
    diff = 0
    for a, b in zip(got, expected):
        diff |= a ^ b
    return diff == 0
`
  );
  task({
    id: "code-reconstruction-001",
    category: "code",
    difficulty: "easy",
    prompt:
      "Reconstruct what the uploaded auth_handler.py actually does: walk through authenticate() line by line, name the " +
      "obfuscation technique and the exact key used for the stored credential blob, and explain WHY the final comparison loop is " +
      "written the way it is (what attack does it mitigate?). Grade claims (OBSERVED / DERIVED / INFERRED / UNKNOWN).",
    fixtureName: "auth_handler.py",
    fixture,
    timeout_ms: 240_000,
    scoring: {
      type: "rubric",
      rubric: [
        { criterion: "Explains the base64-decode + XOR-0x42 credential decode path", weight: 40 },
        { criterion: "Explains the constant-time comparison and the timing-attack it mitigates", weight: 30 },
        { criterion: "Cites evidence with OBSERVED grade (read/derived from the file, not guessed)", weight: 30 },
      ],
    },
  });
}

// code-reconstruction-002 — minified JS parser (HUMAN scoring: code quality).
{
  const fixture = enc(
    `function _p(s){var o={},i=0,q=s.split(";");for(;i<q.length;i++){var e=q[i].indexOf("=");` +
      `if(e<1)continue;var k=q[i].slice(0,e).trim(),v=q[i].slice(e+1).trim();if(k)o[k]=decodeURIComponent(v);}return o}\n` +
      `module.exports={parse:_p};\n`
  );
  task({
    id: "code-reconstruction-002",
    category: "code",
    difficulty: "easy",
    prompt:
      "The uploaded parser.min.js is minified. Reconstruct it as readable, idiomatic source: give the function a clear name, " +
      "restore control flow, add a doc comment describing input/output format and edge-case behavior (what does it do with empty " +
      "segments, missing '=', or keys that trim to empty?). The reconstructed code must stay functionally equivalent.",
    fixtureName: "parser.min.js",
    fixture,
    timeout_ms: 240_000,
    scoring: {
      type: "human",
      rubric: [
        { criterion: "Reconstructed code is functionally equivalent (split/trim/decodeURIComponent logic)", weight: 40 },
        { criterion: "Edge cases documented (empty segments, missing '=', empty keys)", weight: 30 },
        { criterion: "Readable idiomatic naming + doc comment", weight: 30 },
      ],
    },
  });
}

// code-reconstruction-003 — custom wire framing (magic + BE length + rotate-add checksum).
{
  const fixture = enc(
    `# framing.py — captured device link protocol, sender side
MAGIC = b"REA1"

def _checksum(msg: bytes) -> int:
    cs = 0
    for b in msg:
        cs = ((cs << 1) | (cs >> 7)) & 0xFF  # rotate left
        cs = (cs + b) & 0xFF
    return cs

def encode(msg: bytes) -> bytes:
    frame = bytearray()
    frame += MAGIC
    frame += len(msg).to_bytes(2, "big")
    frame += msg
    frame += _checksum(msg).to_bytes(1, "big")
    return bytes(frame)

def decode(buf: bytes):
    if buf[:4] != MAGIC:
        raise ValueError("bad magic")
    n = int.from_bytes(buf[4:6], "big")
    msg = buf[6:6 + n]
    if len(msg) != n:
        raise ValueError("truncated")
    if _checksum(msg) != buf[6 + n]:
        raise ValueError("bad checksum")
    return msg
`
  );
  task({
    id: "code-reconstruction-003",
    category: "code",
    difficulty: "medium",
    prompt:
      "Reconstruct the wire format implemented by the uploaded framing.py PRECISELY: the magic bytes, the exact length-prefix " +
      "size and byte order, and the checksum algorithm (describe the per-byte operation, not just its name). Then state the " +
      "encoded frame for the payload b'PING' — compute the checksum by hand (or with a workspace script) and show your work. " +
      "Grade claims (OBSERVED / DERIVED / INFERRED / UNKNOWN).",
    fixtureName: "framing.py",
    fixture,
    timeout_ms: 300_000,
    scoring: {
      type: "rubric",
      rubric: [
        { criterion: "Identifies magic REA1 and the 2-byte BIG-endian length prefix", weight: 30 },
        { criterion: "Describes the checksum as rotate-left-then-add running byte sum", weight: 40 },
        { criterion: "Produces the correct frame bytes for b'PING' (checksum verifiable arithmetic)", weight: 30 },
      ],
    },
  });
}

// code-reconstruction-004 — obfuscated JS loader (char codes + XOR).
{
  const XOR_KEY_004 = 0x20;
  const URL_004 = "https://example.com/license";
  const payload = Buffer.from(enc(URL_004).map((b) => b ^ XOR_KEY_004));
  const arr = Array.from(payload).map((b) => `0x${b.toString(16).padStart(2, "0")}`);
  const fixture = enc(
    `// loader.js — license endpoint resolver (as recovered)
var _0x4f2a=[${arr.join(",")}];
function _d(a){var s="";for(var i=0;i<a.length;i++){s+=String.fromCharCode(a[i]^${XOR_KEY_004});}return s;}
var _endpoint=_d(_0x4f2a);
function check(lic){return fetch(_endpoint+"?k="+encodeURIComponent(lic)).then(function(r){return r.json();});}
module.exports={check:check};
`
  );
  task({
    id: "code-reconstruction-004",
    category: "code",
    difficulty: "medium",
    prompt:
      "The uploaded loader.js hides its endpoint. Deobfuscate it statically: explain the string-building technique, decode the " +
      "embedded endpoint URL EXACTLY, and describe what check() does at runtime (request shape, what it sends, what it returns). " +
      "You may verify your decode with a workspace script. Grade claims (OBSERVED / DERIVED / INFERRED / UNKNOWN).",
    fixtureName: "loader.js",
    fixture,
    timeout_ms: 300_000,
    scoring: {
      type: "rubric",
      rubric: [
        { criterion: "Decodes the embedded URL exactly: https://example.com/license", weight: 50 },
        { criterion: "Explains the char-code array + XOR-0x20 obfuscation", weight: 30 },
        { criterion: "Describes the runtime fetch (GET ?k=<license>, JSON response)", weight: 20 },
      ],
    },
  });
}

// code-reconstruction-005 — toy VM bytecode reconstruction.
{
  const SECRET_005 = "FLAG{vm_recon_ok}";
  const program: number[] = [];
  for (const ch of enc(SECRET_005)) {
    const encoded = (((ch - 0x03) & 0xff) ^ 0x5f) & 0xff;
    program.push(0x01, encoded, 0x02, 0x5f, 0x03, 0x03, 0x04); // PUSH; XOR 0x5F; ADD 3; EMIT
  }
  program.push(0x00); // HALT
  const fixture = enc(
    `# vm_prog.py — a captured bytecode program + its interpreter skeleton
# ISA (recovered from the interpreter loop):
#   0x01 PUSH imm8   -> reg = imm8
#   0x02 XOR  imm8   -> reg ^= imm8
#   0x03 ADD  imm8   -> reg = (reg + imm8) & 0xFF
#   0x04 EMIT        -> output.append(chr(reg))
#   0x00 HALT
PROGRAM = bytes([${program.join(", ")}])

def run(program):
    reg, out, pc = 0, [], 0
    while pc < len(program):
        op = program[pc]; pc += 1
        if op == 0x00:
            break
        if op == 0x01:
            reg = program[pc]; pc += 1
        elif op == 0x02:
            reg ^= program[pc]; pc += 1
        elif op == 0x03:
            reg = (reg + program[pc]) & 0xFF; pc += 1
        elif op == 0x04:
            out.append(chr(reg & 0xFF))
        else:
            raise ValueError(f"bad opcode {op:#x}")
    return "".join(out)

if __name__ == "__main__":
    print(run(PROGRAM))
`
  );
  task({
    id: "code-reconstruction-005",
    category: "code",
    difficulty: "hard",
    prompt:
      "The uploaded vm_prog.py contains a bytecode PROGRAM and a matching interpreter. Determine the EXACT string the program " +
      "outputs. You may reason statically, or write your own emulator/decoder in the workspace (do not just run the provided " +
      "run() unmodified — show the decoding math per byte). Report the full output string and your method. " +
      "Grade claims (OBSERVED / DERIVED / INFERRED / UNKNOWN).",
    fixtureName: "vm_prog.py",
    fixture,
    timeout_ms: 420_000,
    scoring: {
      type: "rubric",
      rubric: [
        { criterion: "Documents the ISA opcodes correctly (PUSH/XOR/ADD/EMIT/HALT)", weight: 30 },
        { criterion: "Recovers the exact output string FLAG{vm_recon_ok}", weight: 50 },
        { criterion: "Shows the method (per-byte decode math or own emulator script/output)", weight: 20 },
      ],
    },
  });
}

// ---------------------------------------------------------------------------
// MIXED tasks (5)
// ---------------------------------------------------------------------------

// mixed-001 — strings in a binary → live fetch → reconcile.
{
  const fixture = elf64({
    extraStrings: [
      "agent-notes v3",
      "MODULE=telemetry",
      "BUILD_TAG=2024.11-r2",
      "REPORT_URL=https://example.com/summary",
    ],
  });
  task({
    id: "mixed-001",
    category: "mixed",
    difficulty: "easy",
    prompt:
      "The uploaded binary embeds configuration strings. Extract every KEY=VALUE pair you can find, then take the URL it points " +
      "to and fetch it live. Report: the extracted pairs, the HTTP result of the fetch, and a one-paragraph reconciliation of what " +
      "the binary claims vs what the live URL actually serves. Grade claims (OBSERVED / DERIVED / INFERRED / UNKNOWN).",
    fixtureName: "agent-notes.bin",
    fixture,
    timeout_ms: 240_000,
    scoring: {
      type: "rubric",
      rubric: [
        { criterion: "Extracts the pairs (MODULE=telemetry, BUILD_TAG=2024.11-r2, REPORT_URL=...)", weight: 35 },
        { criterion: "Performs a REAL live fetch of https://example.com/summary", weight: 35 },
        { criterion: "Reconciles expectation vs fetch outcome honestly (404 likely, stated plainly)", weight: 30 },
      ],
    },
  });
}

// mixed-002 — embedded JWT triage.
{
  const b64url = (b: Buffer) =>
    b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const header = b64url(enc(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = b64url(
    enc(JSON.stringify({ sub: "svc-agent", scope: "telemetry", iat: 1735689600 }))
  );
  const sig = b64url(createHash("sha256").update("bench-fixture-signature").digest());
  const jwt = `${header}.${payload}.${sig}`;
  const fixture = elf64({
    extraStrings: ["token-harness v1.0", `AUTH_TOKEN:${jwt}`, "svc-agent", "issuer=bench"],
  });
  task({
    id: "mixed-002",
    category: "mixed",
    difficulty: "medium",
    prompt:
      "The uploaded binary carries an AUTH_TOKEN. Decode the token's header and payload (it is a standard compact token), " +
      "state the signing algorithm it declares, and answer honestly: can you VERIFY the signature from the binary alone? " +
      "Explain what would be needed. Also note where in the binary the token sits. Grade claims " +
      "(OBSERVED / DERIVED / INFERRED / UNKNOWN).",
    fixtureName: "token_sample.bin",
    fixture,
    timeout_ms: 300_000,
    scoring: {
      type: "rubric",
      rubric: [
        { criterion: "Decodes header + payload correctly (HS256, sub=svc-agent, scope=telemetry)", weight: 40 },
        { criterion: "Identifies the declared algorithm as HS256 (HMAC-SHA256)", weight: 25 },
        { criterion: "Honestly states the signature cannot be verified without the shared secret", weight: 35 },
      ],
    },
  });
}

// mixed-003 — Python dropper: base64 blob → URL → live fetch.
{
  const URL_003 = "https://example.com/payload";
  const blob = Buffer.from(enc(URL_003)).toString("base64");
  const fixture = enc(
    `# dropper.py — staged config loader (captured sample, defanged)
import base64

CFG = "${blob}"

def cfg_url() -> str:
    return base64.b64decode(CFG).decode("utf-8")

def drop():
    u = cfg_url()
    # stage-2 fetch removed for the sample; the URL is the artifact of interest
    return u
`
  );
  task({
    id: "mixed-003",
    category: "mixed",
    difficulty: "medium",
    prompt:
      "The uploaded dropper.py hides its stage-2 location in a config blob. Decode it, state the exact URL, then fetch it live " +
      "and report what the server actually returns (status + anything notable). Do NOT speculate about the payload content beyond " +
      "what the fetch shows. Grade claims (OBSERVED / DERIVED / INFERRED / UNKNOWN).",
    fixtureName: "dropper.py",
    fixture,
    timeout_ms: 300_000,
    scoring: {
      type: "rubric",
      rubric: [
        { criterion: "Decodes the blob to https://example.com/payload", weight: 30 },
        { criterion: "Performs a REAL live fetch of the URL", weight: 40 },
        { criterion: "Reports the fetch outcome honestly (e.g. 404) without fabrication", weight: 30 },
      ],
    },
  });
}

// mixed-004 — XOR config + SHA-256 constants + live fetch in one target.
{
  const XOR_KEY_004M = 0x5a;
  const PLAINTEXT_004M = "https://updates.example.com/c2";
  const fixture = elf64({
    extraStrings: ["implant cfg v6", "stage2", "KDF", "CONFIG_BLOB:"],
    joinStrings: [xorBuf(enc(PLAINTEXT_004M), XOR_KEY_004M), wordsBE(SHA256_IV)],
  });
  task({
    id: "mixed-004",
    category: "mixed",
    difficulty: "hard",
    prompt:
      "Full triage of the uploaded implant configuration sample: (1) decode the single-byte-XOR value after the 'CONFIG_BLOB:' " +
      "marker (state the key and the decoded URL), (2) identify the hash algorithm whose constants are embedded elsewhere in the " +
      "file (name it and cite the constants), and (3) fetch the decoded URL live and report exactly what comes back. " +
      "Grade claims (OBSERVED / DERIVED / INFERRED / UNKNOWN).",
    fixtureName: "implant_cfg.bin",
    fixture,
    timeout_ms: 420_000,
    scoring: {
      type: "rubric",
      rubric: [
        { criterion: "Identifies XOR key 0x5A and decodes https://updates.example.com/c2", weight: 35 },
        { criterion: "Identifies SHA-256 from its IV constants", weight: 30 },
        { criterion: "Performs a REAL fetch of the decoded URL and reports the outcome honestly", weight: 35 },
      ],
    },
  });
}

// mixed-005 — layered encoding chain (base64 → hex → final message), exact scoring.
{
  const FINAL_005 = "STAGE3::KEY=ea51b0de::REPORT";
  const stage2 = `L2:${Buffer.from(enc(FINAL_005)).toString("hex")}`;
  const stage1 = Buffer.from(enc(stage2)).toString("base64");
  const fixture = enc(
    `STAGED_LOADER v1
STAGE1:${stage1}
# each stage label names the encoding of the NEXT stage
`
  );
  task({
    id: "mixed-005",
    category: "mixed",
    difficulty: "hard",
    prompt:
      "The uploaded staged loader sample is encoded in layers. Peel every layer (identify each encoding, decode it) until you " +
      "reach the final payload message. Report the final message EXACTLY, character for character, plus the chain of encodings " +
      "you removed in order. Grade claims (OBSERVED / DERIVED / INFERRED / UNKNOWN).",
    fixtureName: "staged_loader.bin",
    fixture,
    timeout_ms: 420_000,
    scoring: { type: "exact", expected: FINAL_005 },
  });
}

// ---------------------------------------------------------------------------
// Emit everything + summary
// ---------------------------------------------------------------------------

let totalBytes = 0;
for (const t of tasks) {
  emitTask(t);
  const size = statSync(path.join(TASKS_ROOT, t.id, t.fixtureName)).size;
  totalBytes += size;
  console.log(
    `  ${t.id.padEnd(24)} ${t.category.padEnd(6)} ${t.difficulty.padEnd(6)} fixture=${t.fixtureName.padEnd(20)} ${(size / 1024).toFixed(1)} KB`
  );
}
console.log(
  `\n${tasks.length} tasks emitted, total fixture bytes = ${totalBytes} (${(totalBytes / 1024).toFixed(1)} KB)`
);
if (tasks.length !== 20) {
  console.error("ERROR: expected exactly 20 tasks");
  process.exit(1);
}
