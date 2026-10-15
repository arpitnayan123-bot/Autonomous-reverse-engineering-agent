#!/usr/bin/env bun
/**
 * Specialized RE model registry + inference adapter regression suite
 * (registry.ts + adapters.ts, Architecture C2).
 *
 * Proves, against the REAL database (AgentModel table, test-prefixed rows +
 * the seeded fallback rows, all cleaned up afterwards):
 *   - seedDefaults() creates exactly the five specialized fallback rows
 *     (adapter platform-llm, status fallback, priority 100) and is IDEMPOTENT
 *     — a second run touches nothing;
 *   - registerModel() is idempotent by (task, name) (upsert, no duplicates)
 *     and priority resolution picks the lowest-numbered AVAILABLE model,
 *     ignoring fallback/unavailable rows;
 *   - suggestForTask() with NO available model falls back to the platform
 *     LLM (injected via the platformChat seam — same convention as the
 *     llmOverride injection in the agent tests), usedFallback=true,
 *     provenance INFERRED, and the task-specific system prompt travels with
 *     the call;
 *   - an UNREACHABLE openai-compatible endpoint is honestly observed: the row
 *     flips to "unavailable" in the DB, the reason is recorded and the call
 *     degrades to the platform LLM;
 *   - an empty payload is refused with an honest error BEFORE any model is
 *     contacted (no fabricated suggestions), and unknown tasks likewise;
 *   - the happy path: a real local HTTP server speaking OpenAI
 *     chat-completions serves the suggestion with usedFallback=false and the
 *     row stays "available".
 *
 * Run:  bun test src/server/models/__tests__/models.test.ts
 */
import { describe, test, expect, afterAll } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { db } from "@/lib/db";
import {
  listModels,
  registerModel,
  resolveModelForTask,
  seedDefaults,
  setStatus,
  SEEDED_MODEL_NAME,
  RE_TASKS,
} from "@/server/models/registry";
import {
  suggestForTask,
  SuggestError,
  TASK_PROMPTS,
  type PlatformChatFn,
} from "@/server/models/adapters";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Test rows are name-prefixed so cleanup can never hit operator rows. */
const PREFIX = "models-test-";
const createdIds = new Set<string>();

function track<T extends { id: string }>(model: T): T {
  createdIds.add(model.id);
  return model;
}

interface FakePlatformChat extends PlatformChatFn {
  captured: Array<Array<{ role: string; content: string }>>;
}

/** Stub platform LLM (mirrors the llmOverride injection pattern). */
function fakePlatformChat(reply: string): FakePlatformChat {
  const captured: Array<Array<{ role: string; content: string }>> = [];
  const fn = (async (messages) => {
    captured.push(messages.map((m) => ({ role: m.role, content: m.content })));
    return reply;
  }) as FakePlatformChat;
  fn.captured = captured;
  return fn;
}

afterAll(async () => {
  await db.agentModel.deleteMany({ where: { id: { in: [...createdIds] } } });
  await db.agentModel.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await db.agentModel.deleteMany({
    where: { name: SEEDED_MODEL_NAME, task: { in: [...RE_TASKS] } },
  });
});

const NAME_PAYLOAD = `__int64 __fastcall FUN_14001a2c4(__int64 a1, unsigned int a2)
{
  __int64 v3; // rax
  char v4[260]; // [rsp+20h] [rbp-28h]
  if ( a2 > 0x104 )
    return 0LL;
  v3 = qword_1400A3B20;
  while ( *(_DWORD *)(v3 + 16) != a2 )
  {
    v3 = *(_QWORD *)(v3 + 8);
    if ( !v3 )
      return 0LL;
  }
  memcpy(v4, *(const void **)(v3 + 24), a2);
  v4[a2] = 0;
  return atexit_handler_none(v4);
}`;

// ---------------------------------------------------------------------------
// seedDefaults
// ---------------------------------------------------------------------------

describe("registry.seedDefaults", () => {
  test("creates exactly the 5 fallback rows, idempotently", async () => {
    // Deterministic start: drop any seeded rows from earlier runs/tests.
    await db.agentModel.deleteMany({
      where: { name: SEEDED_MODEL_NAME, task: { in: [...RE_TASKS] } },
    });

    const first = await seedDefaults();
    expect(first.created.sort()).toEqual([...RE_TASKS].sort());
    expect(first.created.length).toBe(5);
    for (const m of first.models) {
      track(m);
      expect(m.name).toBe(SEEDED_MODEL_NAME);
      expect(m.adapter).toBe("platform-llm");
      expect(m.status).toBe("fallback");
      expect(m.priority).toBe(100);
      expect(m.endpoint).toBeNull();
    }
    const rows = await db.agentModel.findMany({ where: { name: SEEDED_MODEL_NAME } });
    expect(rows.length).toBe(5);

    // Second run: pure no-op — nothing created, nothing clobbered.
    const second = await seedDefaults();
    expect(second.created.length).toBe(0);
    expect(second.existing.sort()).toEqual([...RE_TASKS].sort());
    const rowsAfter = await db.agentModel.findMany({ where: { name: SEEDED_MODEL_NAME } });
    expect(rowsAfter.length).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// registerModel + priority resolution
// ---------------------------------------------------------------------------

describe("registry.registerModel + resolution", () => {
  test("priority resolution picks the lowest available, ignores fallback/unavailable", async () => {
    const task = "function-name-recovery";
    const m1 = track(
      await registerModel({
        name: `${PREFIX}qwen-a`,
        task,
        baseModel: "Qwen2.5-Coder-7B-Instruct",
        adapter: "openai-compatible",
        endpoint: "http://127.0.0.1:59991/v1/chat/completions",
        priority: 10,
      })
    );
    expect(m1.status).toBe("available");
    const m2 = track(
      await registerModel({
        name: `${PREFIX}qwen-b`,
        task,
        baseModel: "Qwen2.5-Coder-7B-Instruct",
        adapter: "openai-compatible",
        endpoint: "http://127.0.0.1:59992/v1/chat/completions",
        priority: 5,
      })
    );

    // Seeded fallback row (priority 100, status fallback) must never win.
    const seeded = await listModels({ task });
    expect(seeded.some((m) => m.name === SEEDED_MODEL_NAME && m.status === "fallback")).toBe(true);

    let best = await resolveModelForTask(task);
    expect(best?.id).toBe(m2.id); // priority 5 beats 10 and fallback

    await setStatus(m2.id, "unavailable");
    best = await resolveModelForTask(task);
    expect(best?.id).toBe(m1.id);
  });

  test("re-registering the same (task, name) UPDATES instead of duplicating", async () => {
    const task = "function-name-recovery";
    const name = `${PREFIX}upsert-dup`;
    const first = track(
      await registerModel({
        name,
        task,
        baseModel: "base-a",
        adapter: "openai-compatible",
        endpoint: "http://127.0.0.1:59993/v1/chat/completions",
        priority: 20,
      })
    );
    const second = track(
      await registerModel({
        name,
        task,
        baseModel: "base-b",
        adapter: "openai-compatible",
        endpoint: "http://127.0.0.1:59994/v1/chat/completions",
        priority: 2,
      })
    );
    expect(second.id).toBe(first.id);
    expect(second.baseModel).toBe("base-b");
    expect(second.priority).toBe(2);
    const dupes = await db.agentModel.findMany({ where: { task, name } });
    expect(dupes.length).toBe(1);
  });

  test("validation: unknown task/adapter, missing endpoint, bad priority", async () => {
    const base = {
      name: `${PREFIX}validation`,
      task: "function-name-recovery",
      baseModel: "m",
      adapter: "openai-compatible",
    };
    await expect(
      registerModel({ ...base, task: "not-a-task" as never })
    ).rejects.toThrow(/unknown task/);
    await expect(
      registerModel({ ...base, adapter: "carrier-pigeon" })
    ).rejects.toThrow(/unknown adapter/);
    await expect(
      registerModel({ ...base, endpoint: undefined })
    ).rejects.toThrow(/requires 'endpoint'/);
    await expect(
      registerModel({ ...base, endpoint: "ftp://nope" })
    ).rejects.toThrow(/http\(s\) URL/);
    await expect(
      registerModel({ ...base, endpoint: "http://x/y", priority: -1 })
    ).rejects.toThrow(/priority/);
    await expect(setStatus("no-such-id", "available")).rejects.toThrow(/no model with id/);
    await expect(setStatus("no-such-id", "paused")).rejects.toThrow(/unknown status/);
  });
});

// ---------------------------------------------------------------------------
// suggestForTask
// ---------------------------------------------------------------------------

describe("adapters.suggestForTask", () => {
  test("(no available model) falls back to platform-llm: usedFallback=true, provenance INFERRED", async () => {
    const task = "binary-similarity";
    await seedDefaults(); // ensure the platform-llm row exists for this task
    const fake = fakePlatformChat(
      "similarity: 87/100\nverdict: same-function\nreasons:\n- structural: 9/10 — identical loop shape and branch nesting"
    );

    const res = await suggestForTask(task, NAME_PAYLOAD, { platformChat: fake });

    expect(res.usedFallback).toBe(true);
    expect(res.provenance).toBe("INFERRED");
    expect(res.model.adapter).toBe("platform-llm");
    expect(res.suggestion).toContain("similarity: 87/100");
    expect(res.ms).toBeGreaterThanOrEqual(0);
    expect(res.reason).toContain("no available model");

    // The task-specific prompt + the verbatim payload traveled with the call.
    expect(fake.captured.length).toBe(1);
    expect(fake.captured[0][0].role).toBe("system");
    expect(fake.captured[0][0].content).toBe(TASK_PROMPTS[task]);
    expect(fake.captured[0][0].content).toContain("BINARY FUNCTION SIMILARITY");
    expect(fake.captured[0][1].role).toBe("user");
    expect(fake.captured[0][1].content).toBe(NAME_PAYLOAD);

    // The fallback references the real seeded registry row.
    const platformRow = (await listModels({ task })).find(
      (m) => m.adapter === "platform-llm"
    );
    expect(res.model.id).toBe(platformRow?.id ?? "platform");
  });

  test("(unreachable endpoint) row flips to unavailable in DB and falls back with the reason", async () => {
    const task = "malware-triage";
    const dead = track(
      await registerModel({
        name: `${PREFIX}dead-endpoint`,
        task,
        baseModel: "Qwen2.5-Coder-7B-Instruct",
        adapter: "openai-compatible",
        endpoint: "http://127.0.0.1:9/v1/chat/completions", // port 9 (discard): refused instantly
        priority: 1,
      })
    );
    const fake = fakePlatformChat(
      "1. Summary — installer-like snippet, low confidence.\n2. Indicators — none beyond the input strings."
    );

    const res = await suggestForTask(task, NAME_PAYLOAD, {
      platformChat: fake,
      timeoutMs: 3000,
    });

    expect(res.usedFallback).toBe(true);
    expect(res.provenance).toBe("INFERRED");
    expect(res.model.adapter).toBe("platform-llm");
    expect(res.reason).toContain("failed");
    expect(res.reason).toContain("127.0.0.1:9");

    // The observed failure is persisted — the registry reflects reality.
    const row = await db.agentModel.findUnique({ where: { id: dead.id } });
    expect(row?.status).toBe("unavailable");

    // Exactly one platform call happened (single fallback, no retry storm).
    expect(fake.captured.length).toBe(1);
    expect(fake.captured[0][0].content).toContain("malware analyst assistant");
  });

  test("(empty payload) honest error BEFORE any model is contacted", async () => {
    const fake = fakePlatformChat("should never be produced");
    let err: unknown = null;
    try {
      await suggestForTask("struct-reconstruction", "   \n\t ", { platformChat: fake });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SuggestError);
    expect((err as SuggestError).status).toBe(400);
    expect((err as Error).message).toMatch(/empty/i);
    expect(fake.captured.length).toBe(0);

    // Unknown task is also refused up front, without any model call.
    let err2: unknown = null;
    try {
      await suggestForTask("not-a-task", NAME_PAYLOAD, { platformChat: fake });
    } catch (e) {
      err2 = e;
    }
    expect(err2).toBeInstanceOf(SuggestError);
    expect((err2 as Error).message).toMatch(/unknown task/);
    expect(fake.captured.length).toBe(0);
  });

  test("(happy path) reachable openai-compatible endpoint serves the suggestion, no fallback", async () => {
    const task = "decompile-cleanup";
    // Holder object: TS cannot track assignments made inside the server
    // callback, so the body is read through a stable reference.
    const seen: { body: Record<string, unknown> | null } = { body: null };
    const server: Server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString()));
      req.on("end", () => {
        seen.body = JSON.parse(raw) as Record<string, unknown>;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            choices: [{ message: { content: "```c\n/* cleaned */\n```\n" } }],
          })
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/v1`; // bare /v1 base → auto-completed

    try {
      const model = track(
        await registerModel({
          name: `${PREFIX}live-endpoint`,
          task,
          baseModel: "Qwen2.5-Coder-7B-Instruct",
          adapter: "openai-compatible",
          endpoint: url,
          priority: 1,
        })
      );
      const fake = fakePlatformChat("platform output that must NOT be used");

      const res = await suggestForTask(task, NAME_PAYLOAD, { platformChat: fake });

      expect(res.usedFallback).toBe(false);
      expect(res.provenance).toBe("INFERRED");
      expect(res.model).toEqual({ id: model.id, name: model.name, adapter: "openai-compatible" });
      expect(res.suggestion).toContain("cleaned");
      expect(res.ms).toBeGreaterThanOrEqual(0);
      expect(fake.captured.length).toBe(0); // platform LLM never contacted

      // OpenAI chat-completions contract: model, messages, temperature 0.2, max_tokens 512.
      const body = seen.body;
      expect(body).not.toBeNull();
      expect(body?.model).toBe("Qwen2.5-Coder-7B-Instruct");
      expect(body?.temperature).toBe(0.2);
      expect(body?.max_tokens).toBe(512);
      const messages = (body?.messages ?? []) as Array<{ role: string; content: string }>;
      expect(messages[0].role).toBe("system");
      expect(messages[0].content).toBe(TASK_PROMPTS[task]);
      expect(messages[0].content).toContain("DECOMPILER OUTPUT CLEANUP");
      expect(messages[1].content).toBe(NAME_PAYLOAD);

      // Success must NOT touch the row's status.
      const row = await db.agentModel.findUnique({ where: { id: model.id } });
      expect(row?.status).toBe("available");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
