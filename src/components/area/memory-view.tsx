"use client";

import * as React from "react";
import { BrainCircuit, Globe2, Trash2 } from "lucide-react";

import { apiDelete, apiGet } from "@/lib/api-client";
import { EmptyState, SectionCard, timeAgo, toastError } from "@/components/area/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/hooks/use-toast";

/**
 * Memory tab — browse and manage the agent's cross-session memories
 * (stored via the remember/recall/forget agent tools). Scoped exactly like
 * the chat surface: the current target's memories (when one is attached)
 * and the user's global memories. Deleting a memory takes effect on the
 * very next turn — the loop re-recalls on every new session.
 */

interface MemoryRow {
  id: string;
  key: string;
  value: string;
  scope: "target" | "global";
  targetId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface MemoryResponse {
  ok: boolean;
  target: MemoryRow[] | null;
  global: MemoryRow[];
  targetName: string | null;
}

function MemoryList({
  rows,
  scope,
  deletingKey,
  onDelete,
  emptyTitle,
  emptyDescription,
}: {
  rows: MemoryRow[];
  scope: "target" | "global";
  deletingKey: string | null;
  onDelete: (m: MemoryRow) => void;
  emptyTitle: string;
  emptyDescription: string;
}) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={BrainCircuit}
        title={emptyTitle}
        description={emptyDescription}
        className="border-none bg-transparent"
      />
    );
  }
  return (
    <div className="area-scroll max-h-80 divide-y divide-zinc-800/70 overflow-y-auto rounded-b-lg">
      {rows.map((m) => (
        <div key={m.id} className="group flex items-start gap-3 px-4 py-3">
          <BrainCircuit className="mt-0.5 size-3.5 shrink-0 text-zinc-600" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-2 font-mono text-xs text-zinc-200">
              <span className="break-all">{m.key}</span>
              {m.updatedAt !== m.createdAt && (
                <Badge
                  variant="outline"
                  className="border-zinc-700 px-1.5 py-0 font-mono text-[9px] uppercase tracking-widest text-zinc-500"
                >
                  edited
                </Badge>
              )}
            </p>
            <p className="mt-1 text-xs leading-relaxed break-words whitespace-pre-wrap text-zinc-400">
              {m.value}
            </p>
            <p className="mt-1 font-mono text-[10px] text-zinc-600">
              updated {timeAgo(m.updatedAt)} · stored {timeAgo(m.createdAt)}
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label={`Delete memory ${m.key}`}
            disabled={deletingKey === `${scope}:${m.key}`}
            onClick={() => onDelete(m)}
            className="h-7 shrink-0 gap-1.5 border-zinc-700 px-2 text-[11px] text-zinc-400 opacity-60 transition group-hover:opacity-100 hover:border-rose-500/40 hover:bg-rose-500/10 hover:text-rose-300"
          >
            <Trash2 className="size-3" aria-hidden />
            {deletingKey === `${scope}:${m.key}` ? "Deleting…" : "Delete"}
          </Button>
        </div>
      ))}
    </div>
  );
}

/**
 * Memories for the CURRENT context. `targetId` (optional): when set, the
 * "this target" section is shown above the global section; in free chats
 * (no target) only the global section renders — matching the agent's own
 * recall scoping.
 */
export function MemoryView({
  targetId,
  className,
  showHeader = true,
}: {
  targetId?: string | null;
  className?: string;
  /** Hide the page-level heading when embedded in the inspector side panel. */
  showHeader?: boolean;
}) {
  const [data, setData] = React.useState<MemoryResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [deletingKey, setDeletingKey] = React.useState<string | null>(null);

  const fetchMemories = React.useCallback(async () => {
    try {
      const res = await apiGet<MemoryResponse>(
        targetId ? `/api/memory?targetId=${encodeURIComponent(targetId)}` : "/api/memory"
      );
      setData(res);
    } catch (err) {
      toastError(err, "Could not load memories");
    } finally {
      setLoading(false);
    }
  }, [targetId]);

  React.useEffect(() => {
    setLoading(true);
    setData(null);
    void fetchMemories();
  }, [fetchMemories]);

  const onDelete = async (m: MemoryRow) => {
    const scope: "target" | "global" = m.scope;
    const dedupKey = `${scope}:${m.key}`;
    setDeletingKey(dedupKey);
    try {
      const params = new URLSearchParams({ key: m.key, scope });
      if (scope === "target") {
        if (!m.targetId) {
          toastError(new Error("Memory has no target id — cannot delete"), "Could not delete memory");
          return;
        }
        params.set("targetId", m.targetId);
      }
      await apiDelete<{ ok: boolean }>(`/api/memory?${params.toString()}`);
      toast({
        title: "Memory deleted",
        description: `"${m.key}" will no longer be recalled in future sessions.`,
      });
      await fetchMemories();
    } catch (err) {
      toastError(err, "Could not delete memory");
    } finally {
      setDeletingKey(null);
    }
  };

  if (loading && !data) {
    return (
      <div className={className ?? "space-y-4"}>
        <Skeleton className="h-32 w-full bg-zinc-800/50" />
        <Skeleton className="h-48 w-full bg-zinc-800/40" />
      </div>
    );
  }

  const targetRows = data?.target ?? null;
  const globalRows = data?.global ?? [];
  const totalCount = (targetRows?.length ?? 0) + globalRows.length;

  return (
    <div className={className ?? "space-y-6"}>
      {showHeader && (
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">Agent memory</h2>
          <p className="text-sm text-zinc-500">
            Cross-session facts the agent stored via the remember tool — injected into future
            sessions when relevant. {totalCount} stored.
          </p>
        </div>
      )}

      {targetId && (
        <SectionCard
          title={data?.targetName ? `Memories — ${data.targetName}` : "Memories — this target"}
          description="Recalled only in chats on this target"
          icon={BrainCircuit}
          contentClassName="p-0!"
        >
          <MemoryList
            rows={targetRows ?? []}
            scope="target"
            deletingKey={deletingKey}
            onDelete={(m) => void onDelete(m)}
            emptyTitle="No target-scoped memories"
            emptyDescription="Facts the agent stores with remember (scope “target”) while investigating this file appear here."
          />
        </SectionCard>
      )}

      <SectionCard
        title="Global memories"
        description="Recalled in every chat of this account, including free chats"
        icon={Globe2}
        contentClassName="p-0!"
      >
        <MemoryList
          rows={globalRows}
          scope="global"
          deletingKey={deletingKey}
          onDelete={(m) => void onDelete(m)}
          emptyTitle="No global memories"
          emptyDescription="Preferences and cross-project facts the agent stores with remember (scope “global”) appear here."
        />
      </SectionCard>
    </div>
  );
}
