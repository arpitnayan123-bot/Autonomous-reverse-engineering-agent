import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import {
  listModels,
  registerModel,
  seedDefaults,
  setStatus,
  RE_TASKS,
  type RegisterModelInput,
} from "@/server/models/registry";
import { suggestForTask, SuggestError } from "@/server/models/adapters";

/**
 * Specialized RE model registry REST surface (Architecture C2).
 *
 * GET  /api/models[?task=…]                             → registry with statuses
 * POST /api/models { action: "register", … }            → register/re-configure a model
 * POST /api/models { action: "seed" }                   → seed the 5 fallback tasks
 * POST /api/models { action: "status", id, status }     → flip a model's status
 * POST /api/models { action: "suggest", task, payload } → infer via the chain
 *
 * Every action is auth-required. The suggest action is the honest-inference
 * entry point: empty payloads are refused, endpoint failures are recorded in
 * the registry and degrade to the platform LLM, and results are always
 * provenance INFERRED.
 */

export const runtime = "nodejs";

/** Hard cap for the suggest payload (chars) — decompiled bodies can be big,
 * but unbounded request bodies are an abuse vector. */
const MAX_SUGGEST_PAYLOAD_CHARS = 8000;

function unauthorized() {
  return NextResponse.json({ ok: false, error: "Authentication required" }, { status: 401 });
}

function serializeModel(m: {
  id: string;
  name: string;
  task: string;
  baseModel: string;
  adapter: string;
  endpoint: string | null;
  status: string;
  priority: number;
  metrics: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  let metrics: unknown = null;
  if (m.metrics) {
    try {
      metrics = JSON.parse(m.metrics);
    } catch {
      metrics = null; // unparseable metrics are reported as null, not invented
    }
  }
  return { ...m, metrics };
}

export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return unauthorized();

  const task = req.nextUrl.searchParams.get("task")?.trim() || undefined;
  const models = await listModels(task ? { task } : undefined);
  return NextResponse.json({
    ok: true,
    tasks: RE_TASKS,
    models: models.map(serializeModel),
  });
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return unauthorized();

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "Request body must be JSON" }, { status: 400 });
  }

  const action = typeof body.action === "string" ? body.action : "";

  try {
    switch (action) {
      case "register": {
        const input: RegisterModelInput = {
          name: String(body.name ?? ""),
          task: String(body.task ?? ""),
          baseModel: String(body.baseModel ?? ""),
          adapter: String(body.adapter ?? ""),
          endpoint: typeof body.endpoint === "string" ? body.endpoint : undefined,
          priority: typeof body.priority === "number" ? body.priority : undefined,
        };
        const model = await registerModel(input);
        return NextResponse.json({ ok: true, model: serializeModel(model) });
      }

      case "seed": {
        const result = await seedDefaults();
        return NextResponse.json({
          ok: true,
          createdTasks: result.created,
          existingTasks: result.existing,
          models: result.models.map(serializeModel),
        });
      }

      case "status": {
        const id = typeof body.id === "string" ? body.id.trim() : "";
        const status = typeof body.status === "string" ? body.status.trim() : "";
        if (!id || !status) {
          return NextResponse.json(
            { ok: false, error: "action 'status' requires 'id' and 'status'" },
            { status: 400 }
          );
        }
        const model = await setStatus(id, status);
        return NextResponse.json({ ok: true, model: serializeModel(model) });
      }

      case "suggest": {
        const task = typeof body.task === "string" ? body.task : "";
        const payload = typeof body.payload === "string" ? body.payload : "";
        if (!payload.trim()) {
          return NextResponse.json(
            { ok: false, error: "payload is empty — refusing to fabricate a suggestion" },
            { status: 400 }
          );
        }
        if (payload.length > MAX_SUGGEST_PAYLOAD_CHARS) {
          return NextResponse.json(
            {
              ok: false,
              error: `payload too large (${payload.length} chars; limit ${MAX_SUGGEST_PAYLOAD_CHARS})`,
            },
            { status: 400 }
          );
        }
        const result = await suggestForTask(task, payload);
        return NextResponse.json({ ok: true, result });
      }

      default:
        return NextResponse.json(
          {
            ok: false,
            error: `unknown action '${action}' — expected one of: register, seed, status, suggest`,
          },
          { status: 400 }
        );
    }
  } catch (err) {
    if (err instanceof SuggestError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: err.status });
    }
    const msg = err instanceof Error ? err.message : String(err);
    // Registry validation errors are caller mistakes (400); anything else 500.
    const status = /^registerModel:|^setStatus:/.test(msg) ? 400 : 500;
    return NextResponse.json({ ok: false, error: msg }, { status });
  }
}
