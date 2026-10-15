#!/usr/bin/env bun
/**
 * Seed the community skills marketplace with the three BUNDLED skills
 * (Capability C5): the manifests are pure JSON (no code), authored by
 * "area-system", and every permission names a REAL agent registry tool
 * (verified against AGENT_TOOLS at publish time by the marketplace's
 * allowlist intersection — unknown names would simply never execute).
 *
 * Idempotent BY SLUG+VERSION: a skill already present at the same version is
 * left untouched (installs, ratings and any community edits survive);
 * a LOWER stored version is upgraded via the normal publish path (which
 * enforces the strict semver-increase rule); a HIGHER stored version is
 * skipped with an honest note instead of a downgrade.
 *
 * Run:  bun run skills:seed   (== bun scripts/seed-skills.ts)
 */

import { db } from "@/lib/db";
import { publishSkill } from "@/server/skills/registry";
import { canonicalize, checksumOf, type SkillManifest } from "@/server/skills/manifest";

// ---------------------------------------------------------------------------
// (a) Analyze .NET malware — triage playbook for managed assemblies
// ---------------------------------------------------------------------------

const ANALYZE_DOTNET_MALWARE: SkillManifest = {
  slug: "analyze-dotnet-malware",
  name: "Analyze .NET malware",
  version: "1.0.0",
  description:
    "Structured triage playbook for .NET (CIL) assemblies: identify the managed runtime, map metadata and assembly references, sweep strings for IOCs and behavior indicators, correlate prior analysis findings, and research known families — ending in an evidence-backed verdict.",
  entry: {
    opening:
      "Starting .NET malware triage: I will identify the runtime and metadata, sweep strings for IOCs, correlate prior findings, and deliver an evidence-backed verdict.",
    system: `You are a malware analyst triaging a .NET assembly uploaded to AREA. Work ONLY through your allowed tools; never invent output. Follow this playbook in order and keep a running list of observations with their evidence source.

1. IDENTIFY. Call target_info first — confirm the detected format and check prior analysis runs. Then read_hex offset 0 length 256: confirm the MZ/PE header. For a managed assembly the PE optional header carries a CLR Runtime Descriptor (directory 14) pointing at a stub whose first bytes are the BSJB metadata signature; if you cannot find managed indicators, say honestly that the file may be native or packed and triage accordingly.

2. METADATA SURFACE. Use read_strings to sweep printable strings: assembly/module names, referenced assemblies (mscorlib, System.*), namespaces and type names, resource names. Note versions of referenced libraries — outdated or odd dependency sets are triage signals.

3. BEHAVIORAL STRINGS. In the same sweep hunt for indicators, each recorded with its offset: process execution (cmd.exe, /c, powershell, CreateProcess), network (http://, https://, sockets, DNS), persistence (Run keys, scheduled tasks, startup folders), crypto/obfuscation (FromBase64String, AES, RijndaelManaged, XOR-looking repeated keys), anti-analysis (IsDebuggerPresent, sandbox/usernames), and credential targets (browser paths, mail, FTP).

4. CORRELATE. Call list_findings to pull what prior AREA runs recorded for this target and get_evidence for stored evidence — reconcile rather than repeat: flag agreements and contradictions explicitly.

5. RESEARCH. For distinctive strings (mutexes, campaign names, distinct packer names) use web_research to check public writeups; report what pages you actually fetched and never attribute a family from a hash alone without corroboration.

FINAL VERDICT (always last): classification (benign / grayware / malicious) with confidence, family guess ONLY if evidence supports it, IOC table (string + offset + meaning), capabilities summary, and an honest "not covered" list (e.g. no decompilation of method bodies was available).`,
  },
  permissions: ["target_info", "read_hex", "read_strings", "list_findings", "get_evidence", "web_research"],
  limits: { toolCalls: 16, workspaceBytes: 1024 * 1024, timeoutMs: 90_000 },
};

// ---------------------------------------------------------------------------
// (b) Reverse a WASM module — WebAssembly structure and function inventory
// ---------------------------------------------------------------------------

const REVERSE_WASM_MODULE: SkillManifest = {
  slug: "reverse-wasm-module",
  name: "Reverse a WASM module",
  version: "1.0.0",
  description:
    "WebAssembly analysis playbook: verify the module header, map the section layout (types, imports, exports, memory, code), inventory functions and imports through the RE toolchain, and report suspicious patterns with byte-level evidence.",
  entry: {
    opening:
      "Starting WASM module analysis: I will verify the binary header, map its sections, inventory imports/exports and functions with the RE toolchain, and report structure plus suspicious patterns.",
    system: `You are a reverse engineer analyzing a WebAssembly module in AREA. Use only your allowed tools; every claim must come from tool output. Work the playbook in order.

1. CHECK THE INSTRUMENTS. Call re_tools first: it lists the classical RE toolchain (Ghidra, rizin, pycdc, angr) with LIVE availability and the exact enable command for anything missing. Pick the instrument that supports WebAssembly and be honest when none is installed — a structural report from the raw bytes is still possible.

2. VERIFY THE HEADER. Use read_hex offset 0 length 64: a WASM module starts with the magic 00 61 73 6D ("\\0asm") followed by version bytes 01 00 00 00. If the magic is absent, say so and stop — do not force a WASM reading onto a non-WASM file.

3. MAP THE SECTIONS. Read further hex ranges (max 1024 bytes per call — page through with successive offsets and state the ranges you covered). Each section is one byte id then a LEB128 length: 0 custom/name, 1 type, 2 import, 3 function, 4 table, 5 memory, 6 global, 7 export, 8 start, 9 element, 10 code, 11 data. Decode what you can SEE (ids, sizes, custom name strings like "name" or "producers" in the hex), and mark anything you could not decode as unknown rather than guessing.

4. INVENTORY THROUGH THE TOOLCHAIN. Drive re_tool with the available instrument — 'info' for format metadata, 'functions' for the function list, 'disassemble' for code where supported — passing the module's targetId. Report imports (module.field), exports, memory limits, and a function inventory with sizes.

5. SUSPICION PASS. From everything observed, call out: unexpected imports (WASI calls, filesystem, env), dynamic-behavior patterns (indirect call through tables), odd custom sections, unusual memory sizes, and embedded strings visible in the hex (URLs, base64-like blobs).

FINAL REPORT (always last): header verdict, section table (id, name, byte range), import/export table, function inventory summary, suspicion list with byte evidence, and an honest limitations note (e.g. "no decompiler available for WASM — body-level logic not recovered").`,
  },
  permissions: ["re_tools", "re_tool", "read_hex"],
  limits: { toolCalls: 16, workspaceBytes: 1024 * 1024, timeoutMs: 90_000 },
};

// ---------------------------------------------------------------------------
// (c) Decompile and rebuild — decompiled output → reconstructed workspace
// ---------------------------------------------------------------------------

const DECOMPILE_AND_REBUILD: SkillManifest = {
  slug: "decompile-and-rebuild",
  name: "Decompile and rebuild",
  version: "1.0.0",
  description:
    "Decompile an uploaded binary or bytecode file with the RE toolchain (Ghidra for native code, pycdc for Python bytecode), then reconstruct the sources as a navigable project in a sandboxed workspace, verify what compiles, and report every unresolved gap.",
  entry: {
    opening:
      "Starting decompile-and-rebuild: I will decompile the input with the right tool, reconstruct the sources in a fresh workspace, attempt to compile the result, and report unresolved gaps.",
    system: `You are reconstructing source from a binary in AREA. You have a REAL sandboxed workspace: files you write are committed to a git history you can inspect with workspace_log and workspace_diff. Be honest at every step about what is reconstructed versus guessed.

1. PICK THE INSTRUMENT. Call re_tools to see the toolchain and live availability. Choose: pycdc for Python bytecode (.pyc), Ghidra for native binaries, rizin as a lighter disassembly fallback. If nothing is available, report the exact enable commands and stop — never fabricate a decompilation.

2. DECOMPILE. Drive re_tool with operation 'decompile' (or 'disassemble' where decompilation is unsupported), passing the input's targetId. Keep the raw output manageable: if it is very large, note the total size and work through the most significant functions first.

3. RECONSTRUCT THE TREE. Recreate a navigable project with workspace_write: 'notes/decompiled/…' holds the RAW decompiler output per function (verbatim, trimmed per file only where unavoidable); 'src/…' holds your cleaned-up, compilable reconstruction — real names from the binary preferred, invented names marked with a leading underscore and a TODO comment. One file per logical unit; do not paste everything into a single dump.

4. VERIFY. If the language is known (C from Ghidra, Python from pycdc), attempt a syntax check with workspace_run (for example: python3 -m py_compile on reconstructed Python files — note that only allowlisted commands run, so fall back to careful manual review when the compiler is not allowlisted). Use workspace_list to confirm what actually exists and workspace_log/diff to show the change history.

5. REPORT. Final answer: the workspace tree you built, per-file status (compiles / syntax-checks / manual-only), a mapping table binary-symbol → reconstructed-file, every unresolved symbol/behavior as an explicit TODO, and an honest equivalence statement — a reconstruction is NEVER claimed to be equivalent without evidence.`,
  },
  permissions: [
    "re_tools",
    "re_tool",
    "workspace_list",
    "workspace_read",
    "workspace_write",
    "workspace_run",
    "workspace_diff",
    "workspace_log",
  ],
  limits: { toolCalls: 24, workspaceBytes: 4 * 1024 * 1024, timeoutMs: 120_000 },
};

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

const SEEDS: SkillManifest[] = [
  ANALYZE_DOTNET_MALWARE,
  REVERSE_WASM_MODULE,
  DECOMPILE_AND_REBUILD,
];

async function main(): Promise<void> {
  console.log("[skills-seed] seeding bundled skills…");
  let created = 0;
  let upgraded = 0;
  let skipped = 0;

  for (const manifest of SEEDS) {
    const existing = await db.skill.findUnique({ where: { slug: manifest.slug } });
    if (existing && existing.version === manifest.version) {
      // Idempotent by slug+version — never touch ratings/installs/community rows.
      if (existing.checksum !== checksumOf(manifest)) {
        console.warn(
          `[skills-seed] ${manifest.slug}@${manifest.version} exists with a DIFFERENT checksum (stored=${existing.checksum.slice(0, 12)}… seed=${checksumOf(manifest).slice(0, 12)}…) — left untouched; bump the version to republish.`
        );
      } else {
        console.log(`[skills-seed] ${manifest.slug}@${manifest.version} already present — skipping`);
      }
      skipped += 1;
      continue;
    }
    if (existing && existing.version > manifest.version) {
      console.warn(
        `[skills-seed] ${manifest.slug} is at ${existing.version} (higher than seed ${manifest.version}) — skipping to avoid a downgrade`
      );
      skipped += 1;
      continue;
    }

    const result = await publishSkill({
      manifestJson: manifest,
      author: "area-system",
      bundled: true,
    });
    if (!result.ok) {
      console.error(`[skills-seed] FAILED to seed ${manifest.slug}: ${result.errors.join("; ")}`);
      process.exitCode = 1;
      continue;
    }
    // Integrity self-check: the stored manifest is canonical and its
    // checksum verifies — this is the same recomputation anyone can do.
    const stored = JSON.parse(result.skill.manifest) as SkillManifest;
    const verified = checksumOf(stored) === result.skill.checksum && result.skill.manifest === canonicalize(stored);
    if (!verified) {
      console.error(`[skills-seed] ${manifest.slug}: checksum self-check FAILED`);
      process.exitCode = 1;
      continue;
    }
    if (result.created) {
      console.log(`[skills-seed] created ${manifest.slug}@${manifest.version} checksum=${result.skill.checksum.slice(0, 16)}…`);
      created += 1;
    } else {
      console.log(`[skills-seed] upgraded ${manifest.slug} ${existing?.version} → ${manifest.version} checksum=${result.skill.checksum.slice(0, 16)}…`);
      upgraded += 1;
    }
  }

  console.log(`[skills-seed] done: ${created} created, ${upgraded} upgraded, ${skipped} skipped`);
  await db.$disconnect();
}

main().catch((err) => {
  console.error("[skills-seed] fatal:", err);
  process.exit(1);
});
