"use client";

import * as React from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CapabilitiesView } from "@/components/rea/capabilities-view";
import { SecurityView } from "@/components/rea/security-view";
import { DocsView } from "@/components/rea/docs-view";
import { MemoryView } from "@/components/rea/memory-view";

/**
 * System dialog — engine capabilities, security posture, cross-session agent
 * memory and about/docs in one place (kept out of the main chrome to stay
 * clean). `targetId` (optional) is the CURRENT chat's target — the Memory
 * tab shows that target's scoped memories above the global ones; in free
 * chats it is null and only global memories are listed (same scoping the
 * agent loop itself uses).
 */
export function SystemDialog({
  open,
  onOpenChange,
  targetId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Current chat's target id, null in free chats. */
  targetId?: string | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-hidden border-zinc-800 bg-zinc-950 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-sm text-zinc-100">System</DialogTitle>
          <DialogDescription className="text-xs text-zinc-500">
            Engine health, security posture, agent memory and how REA works.
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="engine" className="flex min-h-0 flex-1 flex-col gap-3">
          <TabsList className="w-fit bg-zinc-900">
            <TabsTrigger value="engine" className="text-xs">Engine</TabsTrigger>
            <TabsTrigger value="security" className="text-xs">Security</TabsTrigger>
            <TabsTrigger value="memory" className="text-xs">Memory</TabsTrigger>
            <TabsTrigger value="about" className="text-xs">About</TabsTrigger>
          </TabsList>
          <div className="min-h-0 flex-1 overflow-y-auto rea-scroll pr-1">
            <TabsContent value="engine" className="mt-0">
              <CapabilitiesView />
            </TabsContent>
            <TabsContent value="security" className="mt-0">
              <SecurityView />
            </TabsContent>
            <TabsContent value="memory" className="mt-0">
              <MemoryView targetId={targetId ?? null} />
            </TabsContent>
            <TabsContent value="about" className="mt-0">
              <DocsView />
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
