import fs from "node:fs";
import path from "node:path";
import { Parser, Language } from "web-tree-sitter";
import { upsertGraph, type NodeRef, type EdgeRef } from "./graph";

/**
 * REA Reverse Engineer — multi-language source parser.
 *
 * Parses source files with tree-sitter (WASM grammars — no code evaluation,
 * hostile input is inert data) and extracts an architecture map: functions,
 * classes, imports, framework endpoints, dependency manifests, and secret
 * patterns. Everything lands in the knowledge graph with honest provenance:
 * symbols and imports are OBSERVED (parsed from the AST), framework routes
 * are DERIVED (pattern match), secret candidates are UNKNOWN (flagged for
 * human review, never auto-confirmed).
 */

const WASM_DIR = path.join(process.cwd(), "node_modules", "tree-sitter-wasms", "out");
const CORE_WASM = path.join(process.cwd(), "node_modules", "web-tree-sitter", "web-tree-sitter.wasm");

const EXT_TO_GRAMMAR: Record<string, string> = {
  ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascript",
  ".ts": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".tsx": "tsx", ".py": "python", ".go": "go", ".rs": "rust",
  ".c": "c", ".h": "c", ".cpp": "cpp", ".cc": "cpp", ".hpp": "cpp",
  ".java": "java", ".rb": "ruby", ".php": "php", ".cs": "c_sharp",
  ".kt": "kotlin", ".swift": "swift", ".scala": "scala", ".sh": "bash", ".bash": "bash",
  ".json": "json", ".css": "css",
};

const MAX_FILES = 300;
const MAX_FILE_BYTES = 300 * 1024;
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "out", "vendor",
  "__pycache__", ".venv", "venv", "target", ".cache", "coverage", ".turbo",
]);

// Module-level caches (survive HMR via globalThis).
const globalForRecon = globalThis as unknown as {
  __reaTsParserReady?: Promise<void>;
  __reaTsLanguages?: Map<string, Language>;
};

async function ensureParser(): Promise<void> {
  if (!globalForRecon.__reaTsParserReady) {
    globalForRecon.__reaTsLanguages = new Map();
    globalForRecon.__reaTsParserReady = Parser.init({
      locateFile: () => CORE_WASM,
    });
  }
  await globalForRecon.__reaTsParserReady;
}

async function getLanguage(grammar: string): Promise<Language | null> {
  await ensureParser();
  const cache = globalForRecon.__reaTsLanguages!;
  if (cache.has(grammar)) return cache.get(grammar)!;
  const wasmPath = path.join(WASM_DIR, `tree-sitter-${grammar}.wasm`);
  if (!fs.existsSync(wasmPath)) return null;
  try {
    const lang = await Language.load(wasmPath);
    cache.set(grammar, lang);
    return lang;
  } catch {
    return null;
  }
}

// --- AST extraction -------------------------------------------------------

interface ExtractedSymbol {
  kind: "function" | "class" | "endpoint" | "component";
  name: string;
  line: number;
  exported: boolean;
}

interface ExtractedFile {
  relPath: string;
  language: string;
  symbols: ExtractedSymbol[];
  imports: string[]; // module specifiers
  parseOk: boolean;
}

function childByName(node: { namedChildren: unknown[] } & Record<string, unknown>, name: string): unknown {
  const kids = node.namedChildren as Array<{ type: string; text?: string }>;
  return kids.find((k) => k.type === name);
}

function nodeText(node: unknown): string {
  const n = node as { text?: string };
  return n?.text ?? "";
}

function nodeName(node: unknown): string | null {
  const n = childByName(node as never, "name");
  return n ? nodeText(n).slice(0, 200) : null;
}

function extractFromFile(relPath: string, absPath: string): ExtractedFile | null {
  const ext = path.extname(relPath).toLowerCase();
  const grammar = EXT_TO_GRAMMAR[ext];
  if (!grammar) return null;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return null;
  }
  if (stat.size > MAX_FILE_BYTES) return null;
  let source: string;
  try {
    source = fs.readFileSync(absPath, "utf8");
  } catch {
    return null;
  }

  const base: ExtractedFile = { relPath, language: grammar, symbols: [], imports: [], parseOk: false };

  // Synchronous parse — Language objects are loaded async beforehand, the
  // parse itself is sync in web-tree-sitter.
  const langs = globalForRecon.__reaTsLanguages;
  if (!langs) return base;

  // We need the language synchronously; ensureParser + getLanguage ran during
  // the pre-walk phase (loadLanguages below), so the cache is warm here.
  const lang = langs.get(grammar);
  if (!lang) return base;
  let parser: Parser;
  try {
    parser = new Parser();
    parser.setLanguage(lang);
  } catch {
    return base;
  }
  let tree;
  try {
    tree = parser.parse(source);
  } catch {
    return base;
  }
  base.parseOk = Boolean(tree?.rootNode);
  if (!tree) return base;

  const isTsFamily = grammar === "typescript" || grammar === "tsx" || grammar === "javascript";
  const root = tree.rootNode;
  const walk = (node: { type: string; startPosition: { row: number }; namedChildren: Array<never>; parent?: unknown }) => {
    switch (node.type) {
      case "function_declaration":
      case "function_definition":
      case "function_item":
      case "method_declaration": {
        const name = nodeName(node);
        if (name) base.symbols.push({ kind: "function", name, line: node.startPosition.row + 1, exported: isExported(node) });
        break;
      }
      case "class_declaration":
      case "class_definition":
      case "struct_item":
      case "class_specifier": {
        const name = nodeName(node);
        if (name) base.symbols.push({ kind: "class", name, line: node.startPosition.row + 1, exported: isExported(node) });
        break;
      }
      case "import_statement":
      case "import_from_statement":
      case "use_declaration": {
        const text = nodeText(node);
        const m = text.match(/["']([^"']{1,200})["']/);
        if (m) base.imports.push(m[1]);
        break;
      }
      case "call_expression": {
        // require("x") — legacy module resolution.
        const text = nodeText(node);
        const m = text.match(/^\s*require\s*\(\s*["']([^"']{1,200})["']/);
        if (m) base.imports.push(m[1]);
        break;
      }
      default:
        break;
    }
    for (const child of node.namedChildren) walk(child as never);
  };
  walk(root as never);

  // React-style components in TS/JSX files: exported PascalCase functions.
  if (isTsFamily) {
    for (const sym of base.symbols) {
      if (sym.kind === "function" && /^[A-Z][A-Za-z0-9_]*$/.test(sym.name)) {
        sym.kind = "component";
      }
    }
  }
  return base;
}

function isExported(node: { parent?: unknown } & Record<string, unknown>): boolean {
  let p = node.parent as { type?: string; parent?: unknown } | undefined;
  for (let i = 0; i < 3 && p; i++) {
    if (p.type === "export_statement") return true;
    p = p.parent as never;
  }
  return false;
}

/** Preload grammars for a set of files (async), so the sync parse sees a warm cache. */
async function loadLanguagesFor(files: Array<{ relPath: string; absPath: string }>): Promise<Set<string>> {
  const grammars = new Set<string>();
  for (const f of files) {
    const g = EXT_TO_GRAMMAR[path.extname(f.relPath).toLowerCase()];
    if (g) grammars.add(g);
  }
  await Promise.all([...grammars].map((g) => getLanguage(g)));
  return grammars;
}

function walkSources(rootDir: string): Array<{ relPath: string; absPath: string }> {
  const out: Array<{ relPath: string; absPath: string }> = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: rootDir, depth: 0 }];
  while (stack.length && out.length < MAX_FILES) {
    const { dir, depth } = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) break;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        if (depth < 8) stack.push({ dir: abs, depth: depth + 1 });
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (EXT_TO_GRAMMAR[ext]) out.push({ relPath: path.relative(rootDir, abs), absPath: abs });
      }
    }
  }
  return out;
}

// --- Manifest fingerprinting (OBSERVED tech + depends-on edges) ------------

function scanManifests(rootDir: string): Array<{ name: string; detail: string }> {
  const tech: Array<{ name: string; detail: string }> = [];
  const read = (p: string) => {
    try {
      return fs.readFileSync(path.join(rootDir, p), "utf8").slice(0, 200_000);
    } catch {
      return null;
    }
  };
  const pkg = read("package.json");
  if (pkg) {
    try {
      const j = JSON.parse(pkg) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const deps = Object.keys({ ...j.dependencies, ...j.devDependencies });
      tech.push({ name: "package-manager:npm-or-bun", detail: `${deps.length} dependencies` });
      for (const key of ["react", "next", "vue", "angular", "@angular/core", "svelte", "express", "fastify", "nest", "@nestjs/core", "prisma", "@prisma/client", "django", "tailwindcss", "electron", "typescript"]) {
        if (deps.some((d) => d === key || d.startsWith(key + "/"))) {
          tech.push({ name: `dependency:${key.replace(/^@/, "").replace("/", "-")}`, detail: key });
        }
      }
    } catch {
      tech.push({ name: "manifest:package.json", detail: "unparseable" });
    }
  }
  if (read("requirements.txt")) {
    tech.push({ name: "package-manager:pip", detail: "requirements.txt" });
    for (const fw of ["django", "flask", "fastapi", "scrapy"]) {
      if (new RegExp(`^\\s*${fw}`, "im").test(read("requirements.txt") ?? "")) {
        tech.push({ name: `dependency:${fw}`, detail: fw });
      }
    }
  }
  if (read("go.mod")) tech.push({ name: "package-manager:go-modules", detail: "go.mod" });
  if (read("Cargo.toml")) tech.push({ name: "package-manager:cargo", detail: "Cargo.toml" });
  if (read("pom.xml")) tech.push({ name: "package-manager:maven", detail: "pom.xml" });
  return tech;
}

// --- Endpoint + secret heuristics (DERIVED / UNKNOWN) ---------------------

const ENDPOINT_PATTERNS: Array<{ rx: RegExp; framework: string; group: number }> = [
  { rx: /\b(?:app|router|server)\.(?:get|post|put|patch|delete|all)\s*\(\s*["'`](\/[^"'`\s]{0,120})["'`]/g, framework: "express-style", group: 1 },
  { rx: /@(?:app|router)\.(?:get|post|put|patch|delete)\s*\(\s*["'`](\/[^"'`\s]{0,120})["'`]/g, framework: "fastapi-flask", group: 1 },
  { rx: /@(?:Get|Post|Put|Patch|Delete|Controller)\s*\(\s*["'`]([^"'`]{0,120})["'`]\s*\)/g, framework: "nestjs", group: 1 },
  { rx: /http\.HandleFunc\s*\(\s*"(\/[^"\s]{0,120})"/g, framework: "go-http", group: 1 },
];

const SECRET_PATTERNS: Array<{ name: string; rx: RegExp }> = [
  { name: "aws-access-key", rx: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "github-pat", rx: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { name: "openai-style-key", rx: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: "google-api-key", rx: /\bAIza[0-9A-Za-z_-]{20,}\b/g },
  { name: "jwt", rx: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g },
  { name: "private-key-block", rx: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { name: "generic-api-key-literal", rx: /\b(?:api[_-]?key|secret|password|token)\s*[:=]\s*["'][^"']{8,}["']/gi },
];

export interface ReconSummary {
  filesParsed: number;
  filesTotal: number;
  symbols: number;
  imports: number;
  endpoints: Array<{ path: string; framework: string; file: string }>;
  secretCandidates: Array<{ name: string; file: string; line: number }>;
  tech: string[];
  languages: Record<string, number>;
  parseErrors: number;
}

export async function reverseEngineerWorkspace(
  projectId: string,
  rootDir: string
): Promise<ReconSummary> {
  const files = walkSources(rootDir);
  await loadLanguagesFor(files);

  const nodes: NodeRef[] = [];
  const edges: EdgeRef[] = [];
  const summary: ReconSummary = {
    filesParsed: 0, filesTotal: files.length, symbols: 0, imports: 0,
    endpoints: [], secretCandidates: [], tech: [], languages: {}, parseErrors: 0,
  };

  const projectNode: NodeRef = {
    kind: "service", key: "project:root", label: path.basename(rootDir) || "workspace",
    provenance: "OBSERVED",
  };
  nodes.push(projectNode);

  for (const f of files) {
    const extracted = extractFromFile(f.relPath, f.absPath);
    if (!extracted) continue;
    if (extracted.parseOk) summary.filesParsed++;
    else summary.parseErrors++;
    summary.languages[extracted.language] = (summary.languages[extracted.language] ?? 0) + 1;

    const fileKey = `file:${extracted.relPath}`;
    nodes.push({
      kind: "component", key: fileKey,
      label: path.basename(extracted.relPath),
      meta: { path: extracted.relPath, language: extracted.language, parsed: extracted.parseOk },
      provenance: "OBSERVED",
    });
    edges.push({ fromKind: "service", fromKey: "project:root", toKind: "component", toKey: fileKey, kind: "contains" });

    for (const sym of extracted.symbols) {
      summary.symbols++;
      const symKey = `${sym.kind}:${extracted.relPath}:${sym.name}`;
      nodes.push({
        kind: sym.kind === "component" ? "component" : sym.kind === "endpoint" ? "endpoint" : sym.kind,
        key: symKey,
        label: `${sym.name}${sym.exported ? " (exported)" : ""}`,
        meta: { file: extracted.relPath, line: sym.line, exported: sym.exported },
        provenance: "OBSERVED",
      });
      edges.push({ fromKind: "component", fromKey: fileKey, toKind: nodes[nodes.length - 1].kind, toKey: symKey, kind: "contains" });
    }

    for (const imp of new Set(extracted.imports)) {
      summary.imports++;
      const impKey = `module:${imp}`;
      nodes.push({ kind: "model", key: impKey, label: imp, provenance: "OBSERVED" });
      edges.push({ fromKind: "component", fromKey: fileKey, toKind: "model", toKey: impKey, kind: "imports" });
    }

    // Endpoint heuristics on the raw source (DERIVED: pattern-matched).
    let source: string | null = null;
    try {
      source = fs.readFileSync(f.absPath, "utf8").slice(0, 300_000);
    } catch {
      continue;
    }
    for (const p of ENDPOINT_PATTERNS) {
      p.rx.lastIndex = 0;
      let m: RegExpExecArray | null;
      let count = 0;
      while ((m = p.rx.exec(source)) && count < 12) {
        count++;
        const routePath = m[p.group];
        if (!routePath || routePath === "/") continue;
        summary.endpoints.push({ path: routePath, framework: p.framework, file: extracted.relPath });
        const epKey = `endpoint:${routePath}`;
        nodes.push({
          kind: "endpoint", key: epKey, label: routePath,
          meta: { framework: p.framework, file: extracted.relPath },
          provenance: "DERIVED",
        });
        edges.push({ fromKind: "component", fromKey: fileKey, toKind: "endpoint", toKey: epKey, kind: "serves" });
      }
    }

    // Secret candidates on the raw source (UNKNOWN: human review required).
    for (const s of SECRET_PATTERNS) {
      s.rx.lastIndex = 0;
      let m: RegExpExecArray | null;
      let count = 0;
      while ((m = s.rx.exec(source)) && count < 5) {
        count++;
        const line = source.slice(0, m.index).split("\n").length;
        summary.secretCandidates.push({ name: s.name, file: extracted.relPath, line });
        nodes.push({
          kind: "finding", key: `secret:${s.name}:${extracted.relPath}:${line}`,
          label: `Secret candidate: ${s.name}`,
          meta: { file: extracted.relPath, line, redacted: true },
          provenance: "UNKNOWN",
        });
      }
    }
  }

  // Manifest tech fingerprinting.
  for (const t of scanManifests(rootDir)) {
    summary.tech.push(t.name);
    nodes.push({ kind: "tech", key: t.name, label: t.detail, provenance: "OBSERVED" });
    edges.push({ fromKind: "service", fromKey: "project:root", toKind: "tech", toKey: t.name, kind: "depends-on" });
  }

  await upsertGraph(projectId, nodes, edges);
  return summary;
}
