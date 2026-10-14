#!/usr/bin/env bun
/**
 * Git-integrated workspace regression suite (builder.ts + the git tools).
 *
 * Proves the workspace's built-in version control end-to-end against REAL
 * git repositories under storage/workspaces/ (gitignored, throwaway):
 *   - creation (ensureWorkspace) runs `git init`, stamps the repo-local
 *     identity "REA Agent <agent@rea.local>" and records the initial EMPTY
 *     commit — idempotently;
 *   - every successful workspace write is auto-committed with the
 *     deterministic message "write: <path> (<bytes> bytes)" and the tree
 *     stays clean;
 *   - an executed command that changes the working tree is auto-committed
 *     ("run: <command>"); a no-op run commits nothing; a sandbox-BLOCKED
 *     command never spawns and commits nothing;
 *   - workspace_diff: two-commit diff carries the real +/- content lines,
 *     the HEAD↔working-tree diff is "(no differences)" on a clean tree, and
 *     one-sided or non-revision args are refused precisely;
 *   - workspace_log: newest-first table of SHA / timestamp / message with
 *     the requested count and a correct default;
 *   - workspace_reset: REFUSED while the tree has uncommitted changes
 *     unless force:true; with force it moves HEAD, reverts tracked files to
 *     the target commit and leaves untracked files in place; "HEAD~N" forms
 *     resolve too;
 *   - git-unavailable degradation: workspaces keep working (writes, runs)
 *     and the three git tools return the EXACT honest error;
 *   - the git argv validator refuses non-allowlisted subcommands and
 *     workspace-escaping flags (--git-dir, --work-tree, -c).
 *
 * Harness notes: each test drives builder functions directly plus
 * runWorkspaceTool (the real tool layer, imported from tools.ts exactly as
 * the agent loop calls it). All git state is asserted through the system git
 * binary from OUTSIDE the sandbox — the test trusts nothing the builder
 * claims without checking the repository itself. Run:
 *   bun test src/server/platform/__tests__/git-workspace.test.ts
 */
import { describe, test, expect, afterAll } from "bun:test";
import { spawnSync } from "child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  CHAT_WORKSPACE_QUOTA_BYTES,
  ensureWorkspace,
  gitAvailable,
  isValidGitRev,
  runCommand,
  runGit,
  setGitAvailabilityForTesting,
  workspaceDir,
  writeFile,
} from "@/server/platform/builder";
import { runWorkspaceTool } from "@/server/agent/tools";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const sid = `gitws-${crypto.randomUUID().slice(0, 8)}`;
const key = `chat-${sid}`; // chatWorkspaceKey(sid)
const session = { sessionId: sid };

const sidOff = `gitoff-${crypto.randomUUID().slice(0, 8)}`;
const keyOff = `chat-${sidOff}`;
const sessionOff = { sessionId: sidOff };

const dir = () => workspaceDir(key);
const dirOff = () => workspaceDir(keyOff);

/** Run REAL git from OUTSIDE the sandbox — the source of truth in assertions. */
function gitSync(dirPath: string, args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const r = spawnSync("git", args, { cwd: dirPath, encoding: "utf8" });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.status ?? -1 };
}

/** Commit subjects, newest first (straight from the repository). */
function commitSubjects(dirPath: string): string[] {
  return gitSync(dirPath, ["log", "--format=%s"])
    .stdout.split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function porcelainStatus(dirPath: string): string {
  return gitSync(dirPath, ["status", "--porcelain"]).stdout;
}

const V1 = "console.log('v1');\n";
const V2 = "console.log('v2');\n";
const MSG_V1 = `write: app.js (${Buffer.byteLength(V1, "utf8")} bytes)`;
const MSG_V2 = `write: app.js (${Buffer.byteLength(V2, "utf8")} bytes)`;

let shaV1 = ""; // commit of app.js v1 (captured in the diff test)

afterAll(async () => {
  setGitAvailabilityForTesting(null);
  await fs.rm(dir(), { recursive: true, force: true });
  await fs.rm(dirOff(), { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("git-integrated workspace", () => {
  test("gitAvailable: the probe finds the real git binary", async () => {
    expect(await gitAvailable()).toBe(true);
  });

  test("init on creation: repo, identity, initial EMPTY commit, idempotent", async () => {
    const d = await ensureWorkspace(key);
    expect(d).toBe(dir());
    expect(fsSync.existsSync(path.join(dir(), ".git"))).toBe(true);

    // Repo-local commit identity stamped at init.
    expect(gitSync(dir(), ["config", "user.name"]).stdout.trim()).toBe("REA Agent");
    expect(gitSync(dir(), ["config", "user.email"]).stdout.trim()).toBe("agent@rea.local");

    // Two commits after init: the housekeeping .gitignore commit (HEAD) and
    // the initial EMPTY commit at the root of the history.
    expect(commitSubjects(dir())).toEqual(["write: .gitignore (6 bytes)", "init"]);
    const root = gitSync(dir(), ["rev-list", "--max-parents=0", "HEAD"]).stdout.trim();
    expect(root).toMatch(/^[0-9a-f]{7,40}$/);
    expect(gitSync(dir(), ["log", "--format=%s", root]).stdout.trim()).toBe("init");
    // The root "init" commit must be EMPTY (no files, no diff).
    const show = gitSync(dir(), ["show", "--stat", "--format=", root]);
    expect(show.stdout.trim()).toBe("");

    // Idempotent: re-ensuring adds no commits and keeps the identity.
    await ensureWorkspace(key);
    expect(commitSubjects(dir())).toEqual(["write: .gitignore (6 bytes)", "init"]);
    expect(gitSync(dir(), ["config", "user.name"]).stdout.trim()).toBe("REA Agent");
  });

  test("auto-commit on workspace_write: deterministic message, clean tree, real receipt", async () => {
    const w1 = await writeFile(key, "hello.txt", "hi", { audit: false, quotaBytes: CHAT_WORKSPACE_QUOTA_BYTES });
    expect(w1.created).toBe(true);
    expect(w1.git?.committed).toBe(true);
    expect(w1.git?.sha).toMatch(/^[0-9a-f]{7,40}$/);

    expect(commitSubjects(dir())[0]).toBe("write: hello.txt (2 bytes)");
    expect(porcelainStatus(dir())).toBe(""); // tree is clean after every write

    // Overwrite: a second deterministic commit; disk content == committed content.
    const w2 = await writeFile(key, "hello.txt", "hello", { audit: false, quotaBytes: CHAT_WORKSPACE_QUOTA_BYTES });
    expect(w2.git?.committed).toBe(true);
    expect(commitSubjects(dir())[0]).toBe("write: hello.txt (5 bytes)");
    expect(gitSync(dir(), ["show", "HEAD:hello.txt"]).stdout).toBe("hello");
    const onDisk = await fs.readFile(path.join(dir(), "hello.txt"), "utf8");
    expect(onDisk).toBe("hello");
  });

  test("auto-commit on run: file-changing runs commit, no-op runs and blocked runs do not", async () => {
    const before = commitSubjects(dir()).length;

    // A run that changes nothing commits nothing.
    const echo = await runCommand(key, "echo hello");
    expect(echo.exitCode).toBe(0);
    expect(commitSubjects(dir()).length).toBe(before);

    // A run that DELETES a file is detected via status before/after and committed.
    const rm = await runCommand(key, "rm hello.txt");
    expect(rm.exitCode).toBe(0);
    expect(commitSubjects(dir())[0]).toBe("run: rm hello.txt");
    expect(porcelainStatus(dir())).toBe("");
    expect(commitSubjects(dir()).length).toBe(before + 1);

    // A sandbox-BLOCKED command never executes — no commit, no tree change.
    const blocked = await runCommand(key, "git status", 30_000, { chatMode: true });
    expect(blocked.blocked).toBeTruthy();
    expect(commitSubjects(dir()).length).toBe(before + 1);
  });

  test("workspace_diff: two-commit diff, clean HEAD↔tree diff, precise arg refusals", async () => {
    const w1 = await writeFile(key, "app.js", V1, { audit: false, quotaBytes: CHAT_WORKSPACE_QUOTA_BYTES });
    expect(commitSubjects(dir())[0]).toBe(MSG_V1);
    shaV1 = w1.git?.sha ?? "";
    expect(shaV1).toMatch(/^[0-9a-f]{7,40}$/);

    await writeFile(key, "app.js", V2, { audit: false, quotaBytes: CHAT_WORKSPACE_QUOTA_BYTES });
    expect(commitSubjects(dir())[0]).toBe(MSG_V2);

    // Two-commit diff carries the REAL content change.
    const diff = await runWorkspaceTool("workspace_diff", { from: shaV1, to: "HEAD" }, session);
    expect(diff).toContain("# workspace_diff — OBSERVED diff");
    expect(diff).toContain("app.js");
    expect(diff).toContain("+console.log('v2');");
    expect(diff).toContain("-console.log('v1');");

    // HEAD ↔ working tree on a clean tree: no differences.
    const clean = await runWorkspaceTool("workspace_diff", {}, session);
    expect(clean).toContain("(no differences)");

    // One-sided args → precise error (never guessed).
    const oneSided = await runWorkspaceTool("workspace_diff", { from: shaV1 }, session);
    expect(oneSided.startsWith("Error:")).toBe(true);
    expect(oneSided).toContain("BOTH");

    // Flag-shaped revisions are refused by the revision validator.
    const injected = await runWorkspaceTool("workspace_diff", { from: "--git-dir=/etc", to: "HEAD" }, session);
    expect(injected.startsWith("Error:")).toBe(true);
    expect(injected).toContain("not a valid revision");
  });

  test("workspace_log: newest-first table with SHA, timestamp, message; count and default", async () => {
    const log3 = await runWorkspaceTool("workspace_log", { count: 3 }, session);
    expect(log3).toContain("# workspace_log — 3 commit(s), newest first");
    expect(log3).toContain("| sha | timestamp | message |");
    const rows3 = log3.split("\n").filter((l) => l.startsWith("| ") && !l.includes("sha | timestamp"));
    expect(rows3.length).toBe(3);
    expect(rows3[0]).toContain(MSG_V2);
    expect(rows3[0]).toMatch(/\| [0-9a-f]{8} \| \d{4}-\d{2}-\d{2}T/); // short SHA + ISO timestamp
    expect(rows3[2]).toContain("run: rm hello.txt");

    // Default count 10: the full history so far — init, .gitignore, hello×2,
    // run: rm, app.js×2 = 7 commits, init last.
    const logDef = await runWorkspaceTool("workspace_log", {}, session);
    const rowsDef = logDef.split("\n").filter((l) => l.startsWith("| ") && !l.includes("sha | timestamp"));
    expect(rowsDef.length).toBe(7);
    expect(rowsDef[0]).toContain(MSG_V2);
    expect(rowsDef[6]).toContain("init");
  });

  test("workspace_reset: refused while dirty, force resets tracked files, HEAD~N works", async () => {
    // Make the tree dirty WITHOUT the auto-commit path (direct fs write → untracked).
    await fs.writeFile(path.join(dir(), "scratch.txt"), "uncommitted work");
    expect(porcelainStatus(dir())).toContain("scratch.txt");

    // Without force: refused, HEAD untouched.
    const refused = await runWorkspaceTool("workspace_reset", { target: shaV1 }, session);
    expect(refused.startsWith("Error:")).toBe(true);
    expect(refused).toContain("uncommitted changes");
    expect(refused).toContain("force");
    expect(refused).toContain("scratch.txt");
    expect(commitSubjects(dir())[0]).toBe(MSG_V2); // HEAD unchanged

    // With force: HEAD moves to the v1 commit and tracked files revert.
    const forced = await runWorkspaceTool("workspace_reset", { target: shaV1, force: true }, session);
    expect(forced).toContain("# workspace_reset — OBSERVED reset");
    expect(forced).toContain(`- target: ${shaV1}`);
    expect(forced).toContain("- HEAD now:");
    expect(forced).toContain("DISCARDED (force:true)");
    expect(commitSubjects(dir())[0]).toBe(MSG_V1);
    expect(gitSync(dir(), ["show", "HEAD:app.js"]).stdout).toBe(V1);
    const appOnDisk = await fs.readFile(path.join(dir(), "app.js"), "utf8");
    expect(appOnDisk).toBe(V1);

    // Untracked files SURVIVE a reset (reset --hard only touches tracked files).
    expect(fsSync.existsSync(path.join(dir(), "scratch.txt"))).toBe(true);

    // HEAD~N form resolves too (still dirty → force again).
    const rel = await runWorkspaceTool("workspace_reset", { target: "HEAD~1", force: true }, session);
    expect(rel).toContain("# workspace_reset — OBSERVED reset");
    expect(commitSubjects(dir())[0]).toBe("run: rm hello.txt");

    // Invalid revisions are refused before git runs.
    const bad = await runWorkspaceTool("workspace_reset", { target: "../escape" }, session);
    expect(bad.startsWith("Error:")).toBe(true);
    expect(bad).toContain("not a valid revision");
    const missing = await runWorkspaceTool("workspace_reset", {}, session);
    expect(missing.startsWith("Error:")).toBe(true);
    expect(missing).toContain("'target' is required");
  });

  test("git-unavailable fallback: workspace keeps working, tools return the exact error", async () => {
    setGitAvailabilityForTesting(false);
    try {
      // Creation: no .git appears, nothing throws.
      await ensureWorkspace(keyOff);
      expect(fsSync.existsSync(path.join(dirOff(), ".git"))).toBe(false);

      // Writes and runs still work — the workspace degrades, it does not break.
      const w = await writeFile(keyOff, "plain.txt", "works", { audit: false, quotaBytes: CHAT_WORKSPACE_QUOTA_BYTES });
      expect(w.bytes).toBe(5);
      expect(w.git).toBeUndefined(); // no git receipt when git is unavailable
      const onDisk = await fs.readFile(path.join(dirOff(), "plain.txt"), "utf8");
      expect(onDisk).toBe("works");
      const run = await runCommand(keyOff, "echo still-works");
      expect(run.exitCode).toBe(0);

      // The three git tools return the EXACT honest error, verbatim.
      const expected = "Error: git is not available on this platform.";
      expect(await runWorkspaceTool("workspace_log", {}, sessionOff)).toBe(expected);
      expect(await runWorkspaceTool("workspace_diff", {}, sessionOff)).toBe(expected);
      expect(await runWorkspaceTool("workspace_reset", { target: "HEAD", force: true }, sessionOff)).toBe(expected);
    } finally {
      setGitAvailabilityForTesting(null); // restore the natural probe
    }
  });

  test("git argv validation: subcommand allowlist and escaping-flag refusals", async () => {
    // Non-allowlisted subcommand.
    const push = await runGit(key, ["push", "origin", "main"]);
    expect(push.exitCode).toBe(126);
    expect(push.stderr).toContain("not allowlisted");

    // Workspace-escaping global options.
    for (const args of [
      ["status", "--git-dir=/etc/passwd"],
      ["status", "--work-tree=/tmp"],
      ["status", "-c", "user.name=evil"],
      ["status", "--exec-path=/evil"],
    ]) {
      const r = await runGit(key, args);
      expect(r.exitCode).toBe(126);
      expect(r.stderr).toContain("forbidden");
    }

    // Empty argv refused.
    expect((await runGit(key, [])).exitCode).toBe(126);

    // The allowed surface still works end-to-end.
    const head = await runGit(key, ["rev-parse", "--verify", "HEAD"]);
    expect(head.exitCode).toBe(0);
    expect(head.stdout.trim()).toMatch(/^[0-9a-f]{7,40}$/);
  });

  test("isValidGitRev: exactly SHAs and HEAD/HEAD~N forms", () => {
    expect(isValidGitRev("HEAD")).toBe(true);
    expect(isValidGitRev("head")).toBe(true);
    expect(isValidGitRev("HEAD~1")).toBe(true);
    expect(isValidGitRev("HEAD~12")).toBe(true);
    expect(isValidGitRev("deadbeef")).toBe(true);
    expect(isValidGitRev("DEADBEEF")).toBe(true);
    expect(isValidGitRev("0123456789abcdef0123456789abcdef01234567")).toBe(true);
    expect(isValidGitRev("")).toBe(false);
    expect(isValidGitRev("abc12")).toBe(false); // too short
    expect(isValidGitRev("HEAD~")).toBe(false);
    expect(isValidGitRev("HEAD~x")).toBe(false);
    expect(isValidGitRev("--git-dir=/etc")).toBe(false);
    expect(isValidGitRev("../escape")).toBe(false);
    expect(isValidGitRev("main")).toBe(false); // not part of the accepted surface
  });
});
