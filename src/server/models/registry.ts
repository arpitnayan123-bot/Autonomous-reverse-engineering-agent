import { db } from "@/lib/db";
import type { AgentModel } from "@prisma/client";

/**
 * Specialized RE model registry (Architecture C2) — DB helpers on the
 * AgentModel table.
 *
 * The registry makes the platform's fallback CHAIN explicit and configurable:
 * out of the box `seedDefaults()` registers five task-keyed rows with
 * adapter "platform-llm", status "fallback", priority 100 — meaning the
 * platform LLM serves every specialized RE task until an operator registers
 * a fine-tuned model (adapter "openai-compatible" pointing at a vLLM /
 * llama.cpp server) that then wins resolution by priority.
 *
 * Semantics of the columns (mirrors prisma/schema.prisma):
 *   task     — one of the five specialized tasks below (plus "general" ad hoc)
 *   adapter  — "openai-compatible" | "local-transformers" | "platform-llm"
 *   status   — "available" (operator-claimed reachable) | "unavailable"
 *              (observed failure — set by the adapter layer) | "fallback"
 *              (the built-in platform LLM serves this task)
 *   priority — lower number = preferred when resolving the task
 *
 * NOTE: AgentModel has no @@unique([task, name]) constraint (schema is
 * frozen for this workstream), so the upsert-by-(task, name) contract is
 * implemented here with findFirst-then-update/create.
 */

export const RE_TASKS = [
  "function-name-recovery",
  "struct-reconstruction",
  "decompile-cleanup",
  "malware-triage",
  "binary-similarity",
] as const;

export type ReTask = (typeof RE_TASKS)[number];

export const RE_TASKS_SET: ReadonlySet<string> = new Set(RE_TASKS);

export const ADAPTERS = ["openai-compatible", "local-transformers", "platform-llm"] as const;
export type Adapter = (typeof ADAPTERS)[number];
export const ADAPTERS_SET: ReadonlySet<string> = new Set(ADAPTERS);

export const MODEL_STATUSES = ["available", "unavailable", "fallback"] as const;
export type ModelStatus = (typeof MODEL_STATUSES)[number];
export const MODEL_STATUSES_SET: ReadonlySet<string> = new Set(MODEL_STATUSES);

/** Display name of the seeded built-in fallback row for each task. */
export const SEEDED_MODEL_NAME = "platform-llm (REA built-in)";

/** baseModel label for the platform fallback (GLM via z-ai-web-dev-sdk). */
const PLATFORM_BASE_MODEL = "glm (platform)";

export function isReTask(task: string): task is ReTask {
  return RE_TASKS_SET.has(task);
}

/** List registry rows, optionally narrowed to one task.
 * Ordered by task, then priority (lower first), then creation order. */
export async function listModels(opts?: { task?: string }): Promise<AgentModel[]> {
  const task = opts?.task?.trim();
  return db.agentModel.findMany({
    where: task ? { task } : undefined,
    orderBy: [{ task: "asc" }, { priority: "asc" }, { createdAt: "asc" }],
  });
}

export interface RegisterModelInput {
  name: string;
  task: string;
  baseModel: string;
  adapter: string;
  endpoint?: string | null;
  priority?: number;
}

/** Validate + normalize a registration. Throws honest, actionable errors. */
function validateRegistration(input: RegisterModelInput): {
  name: string;
  task: string;
  baseModel: string;
  adapter: Adapter;
  endpoint: string | null;
  priority: number;
} {
  const name = (input.name ?? "").trim();
  const task = (input.task ?? "").trim();
  const baseModel = (input.baseModel ?? "").trim();
  const adapter = (input.adapter ?? "").trim();
  if (!name) throw new Error("registerModel: 'name' is required");
  if (!baseModel) throw new Error("registerModel: 'baseModel' is required");
  if (!RE_TASKS_SET.has(task)) {
    throw new Error(`registerModel: unknown task '${task}' — expected one of: ${RE_TASKS.join(", ")}`);
  }
  if (!ADAPTERS_SET.has(adapter)) {
    throw new Error(
      `registerModel: unknown adapter '${adapter}' — expected one of: ${ADAPTERS.join(", ")}`
    );
  }
  const endpointRaw = (input.endpoint ?? "").trim();
  let endpoint: string | null = null;
  if (adapter === "openai-compatible") {
    if (!endpointRaw) {
      throw new Error(
        "registerModel: adapter 'openai-compatible' requires 'endpoint' (e.g. http://127.0.0.1:8000/v1/chat/completions)"
      );
    }
    if (!/^https?:\/\//i.test(endpointRaw)) {
      throw new Error(`registerModel: endpoint must be an http(s) URL, got '${endpointRaw}'`);
    }
    endpoint = endpointRaw.replace(/\/+$/, "");
  } else if (adapter === "platform-llm") {
    // The platform LLM is in-process — an endpoint on this row would be a lie.
    endpoint = null;
  } else {
    // local-transformers: usually in-process on a GPU host; endpoint optional.
    endpoint = endpointRaw || null;
  }
  const priority = input.priority ?? 100;
  if (!Number.isInteger(priority) || priority < 0) {
    throw new Error(
      `registerModel: 'priority' must be a non-negative integer, got ${input.priority}`
    );
  }
  return { name, task, baseModel, adapter: adapter as Adapter, endpoint, priority };
}

/**
 * Register (or re-configure) a model for a task. Idempotent by (task, name):
 * re-registering the same pair UPDATES the row instead of duplicating it.
 *
 * Initial status: "available" for endpoint-backed adapters (operator claims
 * reachability — the adapter layer flips it to "unavailable" on an observed
 * failure), "fallback" for platform-llm rows.
 */
export async function registerModel(input: RegisterModelInput): Promise<AgentModel> {
  const v = validateRegistration(input);
  const status: ModelStatus = v.adapter === "platform-llm" ? "fallback" : "available";
  const existing = await db.agentModel.findFirst({ where: { task: v.task, name: v.name } });
  if (existing) {
    return db.agentModel.update({
      where: { id: existing.id },
      data: {
        baseModel: v.baseModel,
        adapter: v.adapter,
        endpoint: v.endpoint,
        priority: v.priority,
        // A re-registration is an operator action: it re-claims availability
        // (an operator fixing an endpoint must not stay stuck "unavailable").
        status,
      },
    });
  }
  return db.agentModel.create({
    data: {
      name: v.name,
      task: v.task,
      baseModel: v.baseModel,
      adapter: v.adapter,
      endpoint: v.endpoint,
      status,
      priority: v.priority,
    },
  });
}

/** Flip a model's status (the adapter layer marks endpoints unavailable after
 * observed failures; the operator flips back with registerModel or here). */
export async function setStatus(id: string, status: string): Promise<AgentModel> {
  if (!MODEL_STATUSES_SET.has(status)) {
    throw new Error(
      `setStatus: unknown status '${status}' — expected one of: ${MODEL_STATUSES.join(", ")}`
    );
  }
  const existing = await db.agentModel.findUnique({ where: { id } });
  if (!existing) throw new Error(`setStatus: no model with id '${id}'`);
  return db.agentModel.update({ where: { id }, data: { status } });
}

/**
 * Resolve the best AVAILABLE model for a task: status "available" only
 * (rows marked "fallback" or "unavailable" never win), lowest priority
 * number first, ties broken by earliest registration.
 * Returns null when nothing is available — the adapter layer then falls
 * back to the platform LLM.
 */
export async function resolveModelForTask(task: string): Promise<AgentModel | null> {
  const rows = await db.agentModel.findMany({
    where: { task, status: "available" },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    take: 1,
  });
  return rows[0] ?? null;
}

/**
 * The seeded platform-fallback row for a task (any status) — used by the
 * adapter layer so a fallback result can reference a real registry id
 * instead of a synthetic one.
 */
export async function getPlatformModelRow(task: string): Promise<AgentModel | null> {
  return db.agentModel.findFirst({
    where: { task, adapter: "platform-llm" },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
  });
}

export interface SeedDefaultsResult {
  created: string[]; // tasks that had no row and got one
  existing: string[]; // tasks that already had the seeded row (left untouched)
  models: AgentModel[];
}

/**
 * Seed the five specialized tasks with the built-in platform-LLM fallback
 * rows (adapter "platform-llm", status "fallback", priority 100).
 *
 * Idempotent by (task, name): a row that already exists is LEFT UNTOUCHED —
 * re-seeding must never clobber an operator's re-configuration (priority,
 * status, endpoint). Running it twice changes nothing the second time.
 */
export async function seedDefaults(): Promise<SeedDefaultsResult> {
  const created: string[] = [];
  const existing: string[] = [];
  const models: AgentModel[] = [];
  for (const task of RE_TASKS) {
    const row = await db.agentModel.findFirst({
      where: { task, name: SEEDED_MODEL_NAME },
    });
    if (row) {
      existing.push(task);
      models.push(row);
      continue;
    }
    const model = await db.agentModel.create({
      data: {
        name: SEEDED_MODEL_NAME,
        task,
        baseModel: PLATFORM_BASE_MODEL,
        adapter: "platform-llm",
        endpoint: null,
        status: "fallback",
        priority: 100,
      },
    });
    created.push(task);
    models.push(model);
  }
  return { created, existing, models };
}
