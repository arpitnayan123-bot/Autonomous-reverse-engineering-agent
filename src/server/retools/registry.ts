/**
 * RE tool registry — the unified abstraction layer over classical
 * reverse-engineering tools (Capability C1 in docs/ARCHITECTURE.md).
 *
 * Each entry declares WHAT a tool is (kind, image, operations, resource
 * profile) — never HOW to find it. Availability is resolved at runtime:
 *
 *   docker  → the tool's image exists in a reachable container runtime
 *   local   → the tool's binary is on PATH
 *   license → the tool requires a user-provided license (still resolved
 *             via docker/local, but flagged in listings and UI)
 *   none    → honestly unavailable; the runner explains how to enable it
 *
 * Nothing in this file shells out with a shell string — argv arrays only.
 */

export type ReToolKind =
  | "disassembler"
  | "decompiler"
  | "debugger"
  | "symbolic-executor"
  | "analyzer";

export type ReToolOperation = "decompile" | "disassemble" | "functions" | "info" | "symbolic";

export interface ReToolSpec {
  id: string;
  name: string;
  kinds: ReToolKind[];
  /** Container image (tagged). Built from docker/<id>/Dockerfile in this repo. */
  image: string;
  /** Local binary names probed on PATH when the image is absent. */
  localBinaries: string[];
  /** Container entrypoint + fixed argv preceding user arguments. */
  entrypoint: string[];
  /** Local-mode argv preceding user arguments (same semantics as entrypoint). */
  localPrefix: string[];
  /** Repo-relative script injected as the first local-mode argv element (angr). */
  localScript?: string;
  /** Operations this tool supports and how argv is built for each. */
  operations: Record<ReToolOperation, (opts: OperationArgvOpts) => string[]>;
  /** Resource profile for container runs. */
  profile: {
    memory: string; // docker --memory value
    cpus: string; // docker --cpus value
    timeoutMs: number;
  };
  /** Output files the runner should collect from the work dir (relative). */
  outputPaths: string[];
  license?: string; // human-readable licensing note
  description: string;
  docs: string; // how to enable it (used verbatim in honest errors)
}

export interface OperationArgvOpts {
  /** Path of the input INSIDE the execution context (/rea/input in docker). */
  inputPath: string;
  /** Project/output path inside the execution context. */
  outPath: string;
  /** Project name for analyzers that need one (Ghidra). */
  projectName: string;
}

/**
 * Build the complete spec list. Kept as a function (not a const) so tests can
 * import it fresh and so future tools can consult env toggles at spec time.
 */
export function buildRegistry(): ReToolSpec[] {
  return [
    {
      id: "ghidra",
      name: "Ghidra Headless",
      kinds: ["disassembler", "decompiler"],
      image: "rea/ghidra:11",
      localBinaries: ["analyzeHeadless"],
      entrypoint: ["/opt/ghidra/support/analyzeHeadless"],
      localPrefix: ["analyzeHeadless"],
      operations: {
        decompile: (o) => [
          o.outPath, "ReaProject", "-import", o.inputPath,
          "-scriptPath", "/rea/scripts", "-postScript", "ReaDecomp.java", o.outPath,
          "-deleteProject",
        ],
        disassemble: (o) => [
          o.outPath, "ReaProject", "-import", o.inputPath,
          "-scriptPath", "/rea/scripts", "-postScript", "ReaDisasm.java", o.outPath,
          "-deleteProject",
        ],
        functions: (o) => [
          o.outPath, "ReaProject", "-import", o.inputPath,
          "-scriptPath", "/rea/scripts", "-postScript", "ReaFuncs.java", o.outPath,
          "-deleteProject",
        ],
        info: (o) => [
          o.outPath, "ReaProject", "-import", o.inputPath,
          "-scriptPath", "/rea/scripts", "-postScript", "ReaInfo.java", o.outPath,
          "-deleteProject",
        ],
        symbolic: () => { throw new Error("ghidra does not support the symbolic operation"); },
      },
      profile: { memory: "2g", cpus: "2", timeoutMs: 480_000 },
      outputPaths: ["out/decompiled.c", "out/disasm.txt", "out/functions.txt", "out/info.txt"],
      description: "NSA Ghidra headless analyzer: full analysis, decompilation to C-like pseudocode, function enumeration.",
      docs: "Build the backend: docker build -t rea/ghidra:11 docker/ghidra",
    },
    {
      id: "rizin",
      name: "rizin",
      kinds: ["disassembler", "analyzer"],
      image: "rea/rizin:latest",
      localBinaries: ["rizin"],
      entrypoint: ["rizin"],
      localPrefix: ["rizin"],
      operations: {
        decompile: (o) => ["-q", "-c", `aaa; pdg ${o.inputPath} > ${o.outPath}/out/decompiled.c`],
        disassemble: (o) => ["-q", "-c", `aaa; pD 4096 @e:asm.bytes=true > ${o.outPath}/out/disasm.txt`],
        functions: (o) => ["-q", "-c", `aaa; afl > ${o.outPath}/out/functions.txt`],
        info: (o) => ["-q", "-c", `iI > ${o.outPath}/out/info.txt`],
        symbolic: () => { throw new Error("rizin does not support the symbolic operation"); },
      },
      profile: { memory: "1g", cpus: "1", timeoutMs: 180_000 },
      outputPaths: ["out/decompiled.c", "out/disasm.txt", "out/functions.txt", "out/info.txt"],
      description: "rizin (radare2 fork): fast disassembly, function listing, binary info. Decompilation requires the r2ghidra plugin.",
      docs: "Build the backend: docker build -t rea/rizin:latest docker/rizin",
    },
    {
      id: "pycdc",
      name: "pycdc (Decompyle++)",
      kinds: ["decompiler", "disassembler"],
      image: "rea/pycdc:latest",
      localBinaries: ["pycdc", "pycdas"],
      entrypoint: ["pycdc"],
      localPrefix: ["pycdc"],
      operations: {
        decompile: (o) => [o.inputPath, "-o", `${o.outPath}/out`],
        disassemble: () => { throw new Error("pycdc disassembly uses the pycdas binary — invoke re_tool with tool 'pycdas'"); },
        functions: () => { throw new Error("pycdc does not support the functions operation"); },
        info: () => { throw new Error("pycdc does not support the info operation"); },
        symbolic: () => { throw new Error("pycdc does not support the symbolic operation"); },
      },
      profile: { memory: "512m", cpus: "1", timeoutMs: 60_000 },
      outputPaths: ["out/decompiled.py"],
      description: "Decompyle++: Python .pyc bytecode → readable Python source.",
      docs: "Build the backend: docker build -t rea/pycdc:latest docker/pycdc",
    },
    {
      id: "pycdas",
      name: "pycdas (bytecode disassembler)",
      kinds: ["disassembler"],
      image: "rea/pycdc:latest",
      localBinaries: ["pycdas"],
      entrypoint: ["pycdas"],
      localPrefix: ["pycdas"],
      operations: {
        disassemble: (o) => ["-o", `${o.outPath}/out/disasm.txt`, o.inputPath],
        decompile: () => { throw new Error("pycdas only disassembles — use tool 'pycdc' for decompilation"); },
        functions: () => { throw new Error("pycdas does not support the functions operation"); },
        info: () => { throw new Error("pycdas does not support the info operation"); },
        symbolic: () => { throw new Error("pycdas does not support the symbolic operation"); },
      },
      profile: { memory: "512m", cpus: "1", timeoutMs: 60_000 },
      outputPaths: ["out/disasm.txt"],
      description: "Companion disassembler from Decompyle++: .pyc → bytecode listing.",
      docs: "Build the backend: docker build -t rea/pycdc:latest docker/pycdc",
    },
    {
      id: "angr",
      name: "angr",
      kinds: ["symbolic-executor", "analyzer"],
      image: "rea/angr:latest",
      localBinaries: ["python3"],
      entrypoint: ["python3", "/rea/scripts/rea_angr.py"],
      localPrefix: ["python3"],
      localScript: "docker/angr/scripts/rea_angr.py",
      operations: {
        symbolic: (o) => [o.inputPath, "--out", `${o.outPath}/out/symbolic.txt`],
        info: (o) => [o.inputPath, "--out", `${o.outPath}/out/info.txt`, "--info-only"],
        decompile: () => { throw new Error("angr decompilation is exposed via its symbolic/info profile — use ghidra or rizin"); },
        disassemble: () => { throw new Error("angr is not a disassembler — use rizin or ghidra"); },
        functions: () => { throw new Error("angr is not a disassembler — use rizin or ghidra"); },
      },
      profile: { memory: "2g", cpus: "2", timeoutMs: 420_000 },
      outputPaths: ["out/symbolic.txt", "out/info.txt"],
      description: "angr: symbolic execution and binary analysis (find-input analysis, CFG recovery).",
      docs: "Build the backend: docker build -t rea/angr:latest docker/angr",
    },
    {
      id: "ida",
      name: "IDA Pro (headless)",
      kinds: ["disassembler", "decompiler"],
      image: "rea/ida:latest",
      localBinaries: ["idat"],
      entrypoint: ["/opt/ida/idat"],
      localPrefix: ["idat"],
      operations: {
        decompile: (o) => ["-A", `-S"/rea/scripts/rea_ida_decomp.py ${o.outPath}/out/decompiled.c"`, o.inputPath],
        disassemble: (o) => ["-A", `-S"/rea/scripts/rea_ida_disasm.py ${o.outPath}/out/disasm.txt"`, o.inputPath],
        functions: () => { throw new Error("ida functions come with disassembly output"); },
        info: () => { throw new Error("ida info comes with disassembly output"); },
        symbolic: () => { throw new Error("ida does not support the symbolic operation"); },
      },
      profile: { memory: "2g", cpus: "2", timeoutMs: 480_000 },
      outputPaths: ["out/decompiled.c", "out/disasm.txt"],
      license: "Proprietary — requires the operator to supply a licensed IDA image (rea/ida:latest built from their installer). REA never distributes IDA.",
      description: "Hex-Rays IDA headless (idat). Only active when the operator builds a licensed image.",
      docs: "Provide a licensed image: docker build -t rea/ida:latest docker/ida (mount your IDA installer + license)",
    },
    {
      id: "hopper",
      name: "Hopper Disassembler",
      kinds: ["disassembler", "decompiler"],
      image: "rea/hopper:latest",
      localBinaries: ["hopper"],
      entrypoint: ["hopper"],
      localPrefix: ["hopper"],
      operations: {
        decompile: () => { throw new Error("hopper session scripting is not configured — provide docker/hopper"); },
        disassemble: () => { throw new Error("hopper session scripting is not configured — provide docker/hopper"); },
        functions: () => { throw new Error("hopper session scripting is not configured — provide docker/hopper"); },
        info: () => { throw new Error("hopper session scripting is not configured — provide docker/hopper"); },
        symbolic: () => { throw new Error("hopper does not support the symbolic operation"); },
      },
      profile: { memory: "2g", cpus: "1", timeoutMs: 300_000 },
      outputPaths: ["out/decompiled.c"],
      license: "Proprietary — requires the operator to supply a licensed Hopper image.",
      description: "Hopper Disassembler (macOS/Linux). Placeholder profile; activate by providing a licensed image.",
      docs: "Provide a licensed image: docker build -t rea/hopper:latest docker/hopper",
    },
  ];
}

/** Instruments available for a given input file, best-effort static routing. */
export function toolsForFile(fileName: string): string[] {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".pyc") || lower.endsWith(".pyo")) return ["pycdc", "pycdas", "ghidra"];
  if (lower.endsWith(".wasm")) return ["rizin", "ghidra", "angr"];
  if (lower.endsWith(".dex")) return ["rizin", "ghidra"];
  if (lower.endsWith(".so") || lower.endsWith(".o") || lower.endsWith(".elf")) return ["ghidra", "rizin", "angr"];
  if (lower.endsWith(".exe") || lower.endsWith(".dll")) return ["ghidra", "rizin", "angr"];
  if (lower.endsWith(".macho") || lower.endsWith(".dylib")) return ["ghidra", "rizin", "angr"];
  return ["ghidra", "rizin", "angr"];
}
