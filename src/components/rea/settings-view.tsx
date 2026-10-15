"use client";

import * as React from "react";
import { Bot, KeyRound, BookOpen, Cpu, DatabaseBackup } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { ProviderSettings } from "@/components/rea/provider-view";
import { SecurityView } from "@/components/rea/security-view";
import { MemoryView } from "@/components/rea/memory-view";
import { CapabilitiesView } from "@/components/rea/capabilities-view";
import { DocsView } from "@/components/rea/docs-view";

/**
 * /settings — the user settings surface, promoted from the old settings /
 * system dialogs into a page with the same tab content: providers (BYOK),
 * security, memory, engine capabilities and docs.
 */
const TABS = [
  { id: "providers", label: "Providers", icon: KeyRound },
  { id: "security", label: "Security", icon: Bot },
  { id: "memory", label: "Memory", icon: DatabaseBackup },
  { id: "engine", label: "Engine", icon: Cpu },
  { id: "docs", label: "Docs", icon: BookOpen },
] as const;

export function SettingsView({ initialTab }: { initialTab?: string }) {
  const valid = TABS.some((t) => t.id === initialTab) ? initialTab! : "providers";

  return (
    <div className="min-h-0 w-full flex-1 overflow-y-auto rea-scroll">
      <div className="mx-auto w-full max-w-3xl p-4 md:p-6">
        <header className="mb-5">
          <h1 className="flex items-center gap-2 font-mono text-sm font-semibold tracking-widest text-zinc-200">
            <KeyRound className="size-4 text-emerald-400" aria-hidden />
            SETTINGS
          </h1>
          <p className="mt-1 text-xs text-zinc-500">
            Providers, security controls, cross-session memory and engine status for your account.
          </p>
        </header>

        <Tabs defaultValue={valid}>
          <TabsList className="mb-4 flex h-auto w-full flex-wrap justify-start gap-1 bg-zinc-900/70 p-1">
            {TABS.map((t) => (
              <TabsTrigger
                key={t.id}
                value={t.id}
                className="gap-1.5 px-3 py-1.5 font-mono text-[11px] tracking-wide data-[state=active]:bg-emerald-500/15 data-[state=active]:text-emerald-300"
              >
                <t.icon className="size-3" aria-hidden />
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="providers" className="mt-0">
            <ProviderSettings />
          </TabsContent>
          <TabsContent value="security" className="mt-0">
            <SecurityView />
          </TabsContent>
          <TabsContent value="memory" className="mt-0">
            <MemoryView />
          </TabsContent>
          <TabsContent value="engine" className="mt-0">
            <CapabilitiesView />
          </TabsContent>
          <TabsContent value="docs" className="mt-0">
            <DocsView />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
