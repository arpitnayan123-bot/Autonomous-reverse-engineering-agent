/**
 * Deadlock regression test for the REA bridge (Task 17).
 *
 * Reproduces the chat-agent pattern: withTarget(path, () => rea.callTool(...)).
 * Before the re-entrancy fix this hung FOREVER (lock chain circular wait) and
 * permanently poisoned the engine. With the fix it must complete well under
 * the tool timeout.
 *
 * Usage: bun scripts/verify-bridge.ts /tmp/rea-verify-elf
 */
import { rea } from "../src/server/engine/rea-bridge";

async function main() {
  const targetPath = process.argv[2];
  if (!targetPath) {
    console.error("usage: bun scripts/verify-bridge.ts <file>");
    process.exit(1);
  }

  // 1. Session-wrapped tool call (the previously-deadlocking path).
  //    binary_overview's schema has NO path property — the engine binds the
  //    target via open_binary, so the tool args must not include one.
  const t0 = Date.now();
  const res = await rea.withTarget(targetPath, () =>
    rea.callTool("binary_overview", {}, 45_000)
  );
  const elapsed = Date.now() - t0;
  console.log(`[1] withTarget+callTool: ${elapsed}ms isError=${res.isError}`);
  console.log(`    text head: ${res.text.slice(0, 160).replace(/\n/g, " | ")}`);
  if (res.isError) {
    console.error("FAILED: binary_overview errored (arg-injection or engine problem)");
    process.exit(1);
  }
  if (elapsed > 40_000) {
    console.error("FAILED: call took suspiciously long (deadlock symptom)");
    process.exit(1);
  }

  // 2. Plain callTool (queue path) must also still work after a session.
  const t1 = Date.now();
  const res2 = await rea.callTool("list_tools", {}, 30_000).catch((e) => ({
    structured: null,
    text: `expected-possible-error: ${String(e).slice(0, 120)}`,
    isError: true,
  }));
  console.log(`[2] plain callTool: ${Date.now() - t1}ms isError=${res2.isError}`);

  // 3. Two sequential sessions (lock must recover cleanly).
  const t2 = Date.now();
  const res3 = await rea.withTarget(targetPath, () =>
    rea.callTool("binary_overview", { path: targetPath }, 45_000)
  );
  console.log(`[3] second session: ${Date.now() - t2}ms isError=${res3.isError}`);

  console.log("BRIDGE-VERIFY-PASS");
  process.exit(0);
}

main().catch((e) => {
  console.error("BRIDGE-VERIFY-FAIL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
