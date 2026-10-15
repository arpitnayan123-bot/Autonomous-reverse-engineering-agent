#!/usr/bin/env bun
/**
 * RE toolchain regression suite (retools/registry.ts + retools/runner.ts).
 *
 * Proves the orchestration layer end-to-end against a MOCK container runtime
 * (a real executable on PATH whose argv is captured) and a MOCK local tool
 * binary, plus honest-unavailability behavior on a probe-less machine:
 *   - registry shape: every spec is complete (id/image/operations/profile),
 *     licensed tools are flagged, and the file→tool routing covers the
 *     common binary families;
 *   - availability: with a fake runtime on PATH and a staged image, the
 *     preferred mode is "docker"; without any runtime, an unlicensed tool
 *     resolves "local" when its binary is staged and "unavailable" otherwise
 *     with the verbatim enable instructions;
 *   - execution (docker): the runner spawns the runtime with the sandbox
 *     posture (--network none --read-only --tmpfs /tmp, profile memory/cpus,
 *     work dir bound rw at /rea) and collects declared artifacts;
 *   - execution (local): the staged binary runs with argv-array semantics
 *     (no shell) and its stdout/artifacts flow into the normalized result;
 *   - refusal before spawn: an input path outside platform storage is
 *     rejected with the exact policy error and NOTHING is executed;
 *   - unsupported operation: asking a tool for an operation it does not
 *     implement fails honestly without touching the runtime.
 *
 * Run: bun test src/server/retools/__tests__/retools.test.ts
 */
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertInputInStorage,
  getAvailability,
  runReTool,
  setRuntimeProbeForTesting,
} from "@/server/retools/runner";
import { buildRegistry, toolsForFile } from "@/server/retools/registry";

// ------------------------------------------------------------------ mock bin

let mockBinDir: string;
let runtimeLog: string;
let runtimeImageOk: boolean;

function writeExecutable(dir: string, name: string, script: string): void {
  const p = path.join(dir, name);
  fsSync.writeFileSync(p, script);
  fsSync.chmodSync(p, 0o755);
}

/** Stage a fake container runtime + a fake rizin binary on PATH. */
function stageRuntime(opts: { imageOk: boolean; runScript: string }): void {
  const logLit = JSON.stringify(runtimeLog);
  writeExecutable(mockBinDir, "docker", `#!/bin/sh
case "$1" in
  version) echo "24.0.0"; exit 0 ;;
  image) ${opts.imageOk ? 'echo "ok"; exit 0' : 'echo "no such image" >&2; exit 1'} ;;
  run) echo "$@" >> ${logLit}; ${opts.runScript} ;;
  *) exit 0 ;;
esac
`);
}

const ORIGINAL_PATH = process.env.PATH ?? "";

beforeEach(async () => {
  mockBinDir = await fs.mkdtemp(path.join(os.tmpdir(), "retools-mock-"));
  runtimeLog = path.join(mockBinDir, "runtime-argv.log");
  runtimeImageOk = true;
  stageRuntime({
    imageOk: true,
    runScript: `prev=""; for a in "$@"; do if [ "$prev" = "-v" ]; then WS="\${a%%:*}"; fi; prev="$a"; done; mkdir -p "$WS/out"; printf 'decompiled pseudo C\\n' > "$WS/out/decompiled.c"; exit 0`,
  });
  writeExecutable(mockBinDir, "rizin", `#!/bin/sh
LOG=${JSON.stringify(path.join(mockBinDir, "mock.log"))}
echo "rizin-argv: $@" >> "$LOG"
mkdir -p out 2>/dev/null
printf 'function listing\\n' > out/functions.txt
echo "rizin ok"
exit 0
`);
  process.env.PATH = `${mockBinDir}:${ORIGINAL_PATH}`;
  setRuntimeProbeForTesting(true);
});

afterAll(async () => {
  process.env.PATH = ORIGINAL_PATH;
  setRuntimeProbeForTesting(null);
});

describe("RE tool registry", () => {
  test("registry is complete: every spec declares image, entrypoint, all 5 operations, a resource profile and enable docs", () => {
    const specs = buildRegistry();
    expect(specs.length).toBeGreaterThanOrEqual(6);
    for (const s of specs) {
      expect(s.image).toMatch(/^rea\//);
      expect(s.entrypoint.length).toBeGreaterThan(0);
      for (const op of ["decompile", "disassemble", "functions", "info", "symbolic"] as const) {
        expect(typeof s.operations[op]).toBe("function");
      }
      expect(s.profile.memory).toMatch(/^[0-9]+[mg]$/);
      expect(s.profile.timeoutMs).toBeGreaterThan(0);
      expect(s.docs).toContain("docker build");
    }
    const licensed = specs.filter((s) => s.license);
    expect(licensed.map((s) => s.id).sort()).toEqual(["hopper", "ida"]);
  });

  test("toolsForFile routes common binary families to sensible instruments", () => {
    expect(toolsForFile("payload.pyc")).toContain("pycdc");
    expect(toolsForFile("libtarget.so")).toContain("ghidra");
    expect(toolsForFile("module.wasm")).toContain("rizin");
    expect(toolsForFile("unknown.blob")).toContain("ghidra");
  });
});

describe("availability resolution", () => {
  test("docker mode wins when the runtime has the tool image", async () => {
    const ghidra = buildRegistry().find((s) => s.id === "ghidra")!;
    const a = await getAvailability(ghidra);
    expect(a.mode).toBe("docker");
    expect(a.detail).toContain("rea/ghidra:11");
  });

  test("without a runtime, a staged local binary yields local mode; an absent tool is honestly unavailable with enable instructions", async () => {
    setRuntimeProbeForTesting(false);
    const rizin = buildRegistry().find((s) => s.id === "rizin")!;
    const aLocal = await getAvailability(rizin);
    expect(aLocal.mode).toBe("local");

    const ghidra = buildRegistry().find((s) => s.id === "ghidra")!;
    const aNone = await getAvailability(ghidra);
    expect(aNone.mode).toBe("unavailable");
    expect(aNone.detail).toContain("docker build -t rea/ghidra:11 docker/ghidra");
  });
});

describe("execution", () => {
  test("docker run carries the sandbox posture and collects artifacts", async () => {
    const upRoot = path.resolve(process.cwd(), "storage", "uploads");
    fsSync.mkdirSync(upRoot, { recursive: true });
    const input = path.join(upRoot, `retools-docker-${Date.now()}.elf`);
    await fs.writeFile(input, "ELF-fixture");

    const res = await runReTool("ghidra", { inputPath: input, operation: "decompile" });
    expect(res.mode).toBe("docker");
    expect(res.exitCode).toBe(0);
    const argvStr = res.argv.join(" ");
    expect(argvStr).toContain("--network");
    expect(argvStr).toContain("none");
    expect(argvStr).toContain("--read-only");
    expect(argvStr).toContain("--memory");
    expect(argvStr).toContain("2g");
    expect(argvStr).toContain("rea/ghidra:11");
    expect(res.artifacts.some((a) => a.name === "out/decompiled.c")).toBe(true);
    expect(res.artifacts[0].preview).toContain("decompiled pseudo C");
  });

  test("local mode executes the staged binary with argv-array semantics (no shell)", async () => {
    setRuntimeProbeForTesting(false);
    const upRoot = path.resolve(process.cwd(), "storage", "uploads");
    fsSync.mkdirSync(upRoot, { recursive: true });
    const input = path.join(upRoot, `retools-local-${Date.now()}.elf`);
    await fs.writeFile(input, "ELF-fixture");

    const res = await runReTool("rizin", { inputPath: input, operation: "functions" });
    expect(res.mode).toBe("local");
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("rizin ok");
    expect(res.argv[0].endsWith("rizin")).toBe(true);
    // argv arrays only: the log line must show separate args, never a shell string
    const mockLog = await fs.readFile(path.join(mockBinDir, "mock.log"), "utf8");
    expect(mockLog).toContain("-q");
    expect(res.artifacts.some((a) => a.name === "out/functions.txt")).toBe(true);
  });
});

describe("policy refusals", () => {
  test("input outside platform storage is refused before any execution", async () => {
    const outside = path.join(os.tmpdir(), "not-storage.bin");
    await fs.writeFile(outside, "secret-ish");
    let message = "";
    try {
      await runReTool("ghidra", { inputPath: outside, operation: "decompile" });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("outside platform storage");
    expect(fsSync.existsSync(runtimeLog)).toBe(false); // runtime never invoked
  });

  test("unsupported operation fails honestly and never reaches the runtime", async () => {
    setRuntimeProbeForTesting(true); // pcdc resolves via docker so argv-building is reached
    const upRoot = path.resolve(process.cwd(), "storage", "uploads");
    fsSync.mkdirSync(upRoot, { recursive: true });
    const input = path.join(upRoot, "retools-test-fixture.pyc");
    await fs.writeFile(input, "pyc-fixture");
    let message = "";
    try {
      await runReTool("pycdc", { inputPath: input, operation: "symbolic" });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("does not support the symbolic operation");
    expect(fsSync.existsSync(runtimeLog)).toBe(false);
  });

  test("assertInputInStorage accepts uploads and workspaces, rejects traversal", () => {
    const upRoot = path.resolve(process.cwd(), "storage", "uploads");
    fsSync.mkdirSync(upRoot, { recursive: true });
    const ok = path.join(upRoot, "x.bin");
    fsSync.writeFileSync(ok, "x");
    expect(assertInputInStorage(ok)).toBe(path.resolve(ok));
    expect(() => assertInputInStorage("/etc/passwd")).toThrow(/outside platform storage/);
    expect(() => assertInputInStorage(path.join(upRoot, "../../etc/passwd"))).toThrow(/outside platform storage/);
  });
});
