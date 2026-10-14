#!/usr/bin/env bun
/**
 * Docker sandbox regression suite (sandbox.ts + builder.runCommand).
 *
 * Proves the container sandbox end-to-end against a MOCK docker CLI (a real
 * executable on PATH whose argv is captured to a log file) plus the natural
 * availability probe of this machine:
 *   - detection: the probe answers for the real machine, and the test hook
 *     deterministically controls the cached answer;
 *   - container run: the docker argv carries the EXACT sandbox posture
 *     (--rm --network none --read-only --tmpfs /tmp --memory 512m --cpus 1,
 *     workspace bind-mounted rw at /workspace, -w /workspace), the command
 *     is appended as an exec-form argv array (no shell either side), the
 *     scrubbed env rides in as -e pairs with host workspace paths translated
 *     to /workspace, and the image honors REA_SANDBOX_IMAGE;
 *   - fallback: "auto" without a runtime runs the process jail (sandbox:
 *     "process") and "process" always does;
 *   - refusals: "docker" without a daemon is refused with the exact honest
 *     error, and the command policy (allowlist + eval-flag guards) applies
 *     IDENTICALLY inside the container;
 *   - timeout: a container run exceeding its budget is killed (exit 124,
 *     timedOut) — the docker CLI process itself is SIGKILLed;
 *   - bind-mount validation: only absolute, normalized paths inside the
 *     platform workspace root may be mounted; anything else is refused
 *     BEFORE a container is created, and the mount root cannot drift from
 *     builder.workspaceRoot().
 *
 * Run: bun test src/server/platform/__tests__/sandbox.test.ts
 */
import { describe, test, expect, afterEach, afterAll } from "bun:test";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ensureWorkspace,
  runCommand,
  setGitAvailabilityForTesting,
  workspaceDir,
  workspaceRoot,
} from "@/server/platform/builder";
import {
  DEFAULT_SANDBOX_IMAGE,
  containerWorkspaceRoot,
  containerRuntimeBin,
  detectDocker,
  getUserSandboxMode,
  isSandboxMode,
  runInContainer,
  sandboxImage,
  setDockerAvailabilityForTesting,
  validateBindMountPath,
} from "@/server/platform/sandbox";

// ---------------------------------------------------------------------------
// Harness: a mock docker CLI whose argv is captured for assertions
// ---------------------------------------------------------------------------

const sid = `sbx-${crypto.randomUUID().slice(0, 8)}`;
const key = `chat-${sid}`;

const MOCK_LOG = path.join(os.tmpdir(), `mock-docker-${crypto.randomUUID().slice(0, 8)}.log`);
const MOCK_DIR = fsSync.mkdtempSync(path.join(os.tmpdir(), "mock-docker-bin-"));
const MOCK_BIN = path.join(MOCK_DIR, "docker");

/** A docker CLI stand-in: logs `run` invocations (one arg per line; the
 * `version` probe is not logged), replaces itself with a 20s sleep on the
 * "container-sleep-test" marker (exec → no leftover pipe holder), otherwise
 * exits 0 with a marker line. */
const MOCK_SCRIPT = [
  "#!/usr/bin/env bash",
  'if [ "$1" = "run" ]; then',
  `  printf '%s\\n' "$@" >> "${MOCK_LOG}"`,
  "fi",
  'for a in "$@"; do',
  '  if [ "$a" = "container-sleep-test" ]; then exec sleep 20; fi',
  "done",
  'echo "container-ran"',
  "exit 0",
  "",
].join("\n");

const SAVED_PATH = process.env.PATH;
let savedImage: string | undefined;

function useMockDocker(): void {
  fsSync.writeFileSync(MOCK_BIN, MOCK_SCRIPT, { mode: 0o755 });
  process.env.PATH = `${MOCK_DIR}:${SAVED_PATH}`;
  fsSync.rmSync(MOCK_LOG, { force: true }); // fresh log per test
  setDockerAvailabilityForTesting(null); // re-probe → the mock answers
}

function useNoDocker(): void {
  process.env.PATH = SAVED_PATH;
  setDockerAvailabilityForTesting(false);
}

function restoreRuntime(): void {
  process.env.PATH = SAVED_PATH;
  setDockerAvailabilityForTesting(null);
}

function mockLogLines(): string[] {
  try {
    return fsSync.readFileSync(MOCK_LOG, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function cleanWorkspace(): Promise<void> {
  await fs.rm(workspaceDir(key), { recursive: true, force: true });
}

afterEach(() => {
  restoreRuntime();
  if (savedImage === undefined) delete process.env.REA_SANDBOX_IMAGE;
  else process.env.REA_SANDBOX_IMAGE = savedImage;
  savedImage = undefined;
});

afterAll(async () => {
  setDockerAvailabilityForTesting(null);
  setGitAvailabilityForTesting(null);
  await cleanWorkspace();
  await fs.rm(MOCK_DIR, { recursive: true, force: true });
  await fs.rm(MOCK_LOG, { force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("docker sandbox", () => {
  test("detection: probe answers for this machine; the hook controls the cached answer", async () => {
    const real = await detectDocker();
    expect(typeof real).toBe("boolean");
    // Cached: the second call agrees without re-probing.
    expect(await detectDocker()).toBe(real);
    const bin = await containerRuntimeBin();
    if (real) expect(bin).toBeTruthy();
    else expect(bin).toBe(null);

    setDockerAvailabilityForTesting(true);
    expect(await detectDocker()).toBe(true);
    expect(await containerRuntimeBin()).toBe("docker");

    setDockerAvailabilityForTesting(false);
    expect(await detectDocker()).toBe(false);
    expect(await containerRuntimeBin()).toBe(null);

    // Re-probe naturally → the real machine's answer again.
    setDockerAvailabilityForTesting(null);
    expect(await detectDocker()).toBe(real);
  });

  test("container run with a mock docker CLI: exact sandbox argv, env translation, honest result", async () => {
    useMockDocker();
    savedImage = process.env.REA_SANDBOX_IMAGE;
    process.env.REA_SANDBOX_IMAGE = "rea-test-image:9";
    await ensureWorkspace(key);

    const r = await runCommand(key, "node script.js", 30_000, { sandbox: "auto" });
    // The mock exits 0 and prints its marker — a REAL observed execution.
    expect(r.blocked).toBeUndefined();
    expect(r.sandbox).toBe("docker");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("container-ran");

    // Log captured ONLY this run (the `version` probe is not logged).
    const lines = mockLogLines();
    // Exec form: `run --rm --network none --read-only --tmpfs /tmp --memory
    // 512m --cpus 1 -v <dir>:/workspace:rw -w /workspace -e K=V… <image> node script.js`
    expect(lines[0]).toBe("run");
    expect(lines[1]).toBe("--rm");
    expect(lines.slice(2, 13)).toEqual([
      "--network", "none",
      "--read-only",
      "--tmpfs", "/tmp",
      "--memory", "512m",
      "--cpus", "1",
      "-v", `${workspaceDir(key)}:/workspace:rw`,
    ]);
    expect(lines[13]).toBe("-w");
    expect(lines[14]).toBe("/workspace");
    // Scrubbed env rides in as -e pairs; HOME points at the CONTAINER mount.
    expect(lines).toContain("-e");
    const envValues = lines.filter((l) => l.startsWith("NO_COLOR=") || l.startsWith("CI="));
    expect(envValues).toContain("NO_COLOR=1");
    expect(envValues).toContain("CI=1");
    expect(lines).toContain("HOME=/workspace");
    // The image honors REA_SANDBOX_IMAGE, and the command follows it as a
    // plain argv array — never wrapped in a shell (no sh -c anywhere).
    expect(lines).toContain("rea-test-image:9");
    const imageIdx = lines.indexOf("rea-test-image:9");
    expect(lines.slice(imageIdx + 1)).toEqual(["node", "script.js"]);
    expect(lines).not.toContain("sh");
    expect(lines).not.toContain("-c");

    // Direct call: same posture, same honest envelope (argv asserted on the
    // returned receipt, not the log — the log stays run #1's).
    fsSync.rmSync(MOCK_LOG, { force: true });
    const c = await runInContainer(workspaceDir(key), "node other.js", 30_000, { HOME: workspaceDir(key) });
    expect(c.image).toBe("rea-test-image:9");
    expect(c.exitCode).toBe(0);
    expect(c.stdout).toContain("container-ran");
    expect(c.argv[c.argv.length - 2]).toBe("node");
    expect(c.argv[c.argv.length - 1]).toBe("other.js");
    expect(c.argv).toContain("HOME=/workspace");
    expect(c.argv.slice(0, 13)).toEqual([
      "run", "--rm",
      "--network", "none",
      "--read-only",
      "--tmpfs", "/tmp",
      "--memory", "512m",
      "--cpus", "1",
      "-v", `${workspaceDir(key)}:/workspace:rw`,
    ]);
  });

  test("auto falls back to the process jail when no runtime answers; process mode always uses it", async () => {
    useNoDocker();
    await ensureWorkspace(key);

    // Default (no option) = auto → the historical jail.
    const dflt = await runCommand(key, "echo process-jail-ok");
    expect(dflt.sandbox).toBe("process");
    expect(dflt.exitCode).toBe(0);
    expect(dflt.stdout).toContain("process-jail-ok");

    // Explicit "process" is honored verbatim.
    const forced = await runCommand(key, "echo process-forced-ok", 30_000, { sandbox: "process" });
    expect(forced.sandbox).toBe("process");
    expect(forced.stdout).toContain("process-forced-ok");

    // The preference reader degrades to "auto" without a user row.
    expect(await getUserSandboxMode(undefined)).toBe("auto");
    expect(isSandboxMode("docker")).toBe(true);
    expect(isSandboxMode("bananas")).toBe(false);
  });

  test("docker mode without a runtime is refused; the command policy applies inside the container too", async () => {
    // No daemon: an explicit docker request must refuse — never downgrade.
    useNoDocker();
    const refused = await runCommand(key, "echo hi", 30_000, { sandbox: "docker" });
    expect(refused.blocked).toBeTruthy();
    expect(refused.stderr).toContain("Docker sandbox requested but not available");
    expect(refused.sandbox).toBeUndefined(); // nothing ran, nothing to report

    // With the mock runtime up, the ALLOWLIST still gates every mode.
    useMockDocker();
    const curl = await runCommand(key, "curl example.com", 30_000, { sandbox: "docker" });
    expect(curl.blocked).toBeTruthy();
    expect(curl.stderr).toContain("not in the workspace allowlist");
    expect(mockLogLines()).not.toContain("run"); // no container was created

    // Chat-mode eval-flag guard survives the container path as well.
    const evald = await runCommand(key, 'node -e "process.exit(0)"', 30_000, { chatMode: true, sandbox: "docker" });
    expect(evald.blocked).toBeTruthy();
    expect(evald.stderr).toContain("inline code evaluation");
  });

  test("timeout enforcement inside the container: SIGKILL, exit 124, timedOut", async () => {
    useMockDocker();
    await ensureWorkspace(key);
    const before = Date.now();
    const r = await runCommand(key, "node container-sleep-test", 600, { sandbox: "auto" });
    expect(r.sandbox).toBe("docker");
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(124);
    expect(Date.now() - before).toBeGreaterThanOrEqual(550);
    expect(Date.now() - before).toBeLessThan(15_000); // killed long before the sleep ends
  });

  test("bind-mount path validation: only workspace-root paths may be mounted", async () => {
    // The two roots cannot drift apart.
    expect(containerWorkspaceRoot()).toBe(workspaceRoot());

    // Refusals: outside the root, relative, or escaping via "..".
    const outside = validateBindMountPath("/etc");
    expect(outside.ok).toBe(false);
    if (!outside.ok) expect(outside.error).toContain("outside the platform workspace root");

    const rel = validateBindMountPath("storage/workspaces/x");
    expect(rel.ok).toBe(false);

    const escape = validateBindMountPath(path.join(workspaceRoot(), "..", "elsewhere"));
    expect(escape.ok).toBe(false);

    // The real workspace dir validates.
    await ensureWorkspace(key);
    const good = validateBindMountPath(workspaceDir(key));
    expect(good.ok).toBe(true);

    // A rejected mount refuses BEFORE any container is created — even with
    // a (mock) runtime up, docker is never invoked for it.
    useMockDocker();
    const logBefore = mockLogLines().length;
    const c = await runInContainer("/etc", "node x.js", 1_000, {});
    expect(c.exitCode).toBe(126);
    expect(c.refused).toContain("bind-mount path validation failed");
    expect(mockLogLines().length).toBe(logBefore);

    // Image default: node:20-alpine unless REA_SANDBOX_IMAGE overrides.
    delete process.env.REA_SANDBOX_IMAGE;
    expect(sandboxImage()).toBe(DEFAULT_SANDBOX_IMAGE);
    expect(DEFAULT_SANDBOX_IMAGE).toBe("node:20-alpine");
  });
});
