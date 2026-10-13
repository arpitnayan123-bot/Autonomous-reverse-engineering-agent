import { db } from "@/lib/db";

/**
 * Knowledge-graph upsert helpers.
 *
 * Nodes are deduplicated per project by (kind,key); edges by their endpoints
 * + kind. Every write carries a provenance level matching the evidence
 * ledger doctrine: OBSERVED (directly seen), DERIVED (computed), INFERRED
 * (agent conclusion), UNKNOWN (unconfirmed).
 */

export type Provenance = "OBSERVED" | "DERIVED" | "INFERRED" | "UNKNOWN";

export interface NodeRef {
  kind: string; // page|asset|api|endpoint|component|service|model|tech|function|class|finding
  key: string;
  label: string;
  meta?: Record<string, unknown>;
  provenance?: Provenance;
}

export interface EdgeRef {
  fromKind: string;
  fromKey: string;
  toKind: string;
  toKey: string;
  kind: string; // links-to|calls|imports|serves|depends-on|contains|references
  meta?: Record<string, unknown>;
  provenance?: Provenance;
}

const MAX_META_JSON = 8_000; // keep SQLite rows bounded

function metaToJson(meta?: Record<string, unknown>): string | null {
  if (!meta || Object.keys(meta).length === 0) return null;
  try {
    const json = JSON.stringify(meta);
    return json.length > MAX_META_JSON
      ? JSON.stringify({ truncated: true, preview: json.slice(0, MAX_META_JSON) })
      : json;
  } catch {
    return null;
  }
}

export async function upsertNode(projectId: string, node: NodeRef): Promise<void> {
  const meta = metaToJson(node.meta);
  await db.graphNode.upsert({
    where: {
      projectId_kind_key: {
        projectId,
        kind: node.kind,
        key: node.key,
      },
    },
    create: {
      projectId,
      kind: node.kind,
      key: node.key,
      label: node.label.slice(0, 300),
      meta,
      provenance: node.provenance ?? "OBSERVED",
    },
    update: {
      label: node.label.slice(0, 300),
      meta: meta ?? undefined,
      provenance: node.provenance ?? undefined,
    },
  });
}

export async function upsertEdge(projectId: string, edge: EdgeRef): Promise<void> {
  await db.graphEdge.upsert({
    where: {
      projectId_fromKind_fromKey_toKind_toKey_kind: {
        projectId,
        fromKind: edge.fromKind,
        fromKey: edge.fromKey,
        toKind: edge.toKind,
        toKey: edge.toKey,
        kind: edge.kind,
      },
    },
    create: {
      projectId,
      fromKind: edge.fromKind,
      fromKey: edge.fromKey,
      toKind: edge.toKind,
      toKey: edge.toKey,
      kind: edge.kind,
      meta: metaToJson(edge.meta),
      provenance: edge.provenance ?? "OBSERVED",
    },
    update: {
      provenance: edge.provenance ?? undefined,
      meta: metaToJson(edge.meta) ?? undefined,
    },
  });
}

/** Upsert a batch of nodes/edges with bounded concurrency (DB-friendly). */
export async function upsertGraph(
  projectId: string,
  nodes: NodeRef[],
  edges: EdgeRef[]
): Promise<void> {
  for (const n of nodes) {
    await upsertNode(projectId, n);
  }
  for (const e of edges) {
    await upsertEdge(projectId, e);
  }
}

export interface GraphSnapshot {
  nodes: Array<{
    id: string;
    kind: string;
    key: string;
    label: string;
    provenance: string;
    meta: unknown;
  }>;
  edges: Array<{
    fromKind: string;
    fromKey: string;
    toKind: string;
    toKey: string;
    kind: string;
    provenance: string;
  }>;
}

/** Read a bounded graph snapshot for the UI (largest projects stay renderable). */
export async function graphSnapshot(
  projectId: string,
  limit = 400
): Promise<GraphSnapshot> {
  const [nodes, edges] = await Promise.all([
    db.graphNode.findMany({
      where: { projectId },
      orderBy: { updatedAt: "desc" },
      take: limit,
    }),
    db.graphEdge.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      take: limit * 3,
    }),
  ]);
  const keySet = new Set(nodes.map((n) => `${n.kind}\u0000${n.key}`));
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      key: n.key,
      label: n.label,
      provenance: n.provenance,
      meta: n.meta ? safeParse(n.meta) : null,
    })),
    edges: edges
      .filter((e) => keySet.has(`${e.fromKind}\u0000${e.fromKey}`) && keySet.has(`${e.toKind}\u0000${e.toKey}`))
      .map((e) => ({
        fromKind: e.fromKind,
        fromKey: e.fromKey,
        toKind: e.toKind,
        toKey: e.toKey,
        kind: e.kind,
        provenance: e.provenance,
      })),
  };
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
