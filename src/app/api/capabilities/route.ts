import { existsSync } from "node:fs";
import { NextResponse } from "next/server";
import { rea, reaEngineInfo } from "@/server/engine/rea-bridge";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";

const HOST_TOOL_DIRS = ["/usr/bin", "/usr/local/bin", "/bin"];
const HOST_TOOLS = ["strings", "file", "objdump", "python3"];

interface CapabilityTool {
  name: string;
  title: string;
  description: string;
  kind: string;
}

function probeHostTool(name: string): boolean {
  for (const dir of HOST_TOOL_DIRS) {
    try {
      if (existsSync(`${dir}/${name}`)) return true;
    } catch {
      /* continue */
    }
  }
  return false;
}

export async function GET() {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Authentication required" },
        { status: 401 }
      );
    }

    const engine = await reaEngineInfo();
    const toolDefs = await rea.listTools().catch(() => []);
    const tools: CapabilityTool[] = toolDefs
      .slice(0, 200)
      .map((t) => {
        const annotations =
          t.annotations && typeof t.annotations === "object"
            ? (t.annotations as Record<string, unknown>)
            : null;
        const kind =
          annotations && typeof annotations.kind === "string"
            ? annotations.kind
            : "rea";
        return {
          name: t.name,
          title: t.title || t.name,
          description: (t.description || "").slice(0, 300),
          kind,
        };
      });

    const hostTools = HOST_TOOLS.map((name) => ({
      name,
      available: probeHostTool(name),
    }));

    return NextResponse.json({
      ok: true,
      engine,
      tools,
      hostTools,
      providers: {
        native: false,
        reason:
          "Hopper/Ghidra/IDA are bring-your-own desktop analysis engines; not available in this hosted environment. All static/artifact/bytecode tools are fully available.",
      },
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Capabilities unavailable",
      },
      { status: 500 }
    );
  }
}
