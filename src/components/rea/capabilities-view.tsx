"use client";

import * as React from "react";
import { Code2, Info, PlugZap, Puzzle, Search, Wrench } from "lucide-react";

import { apiGet, type Capabilities as CapabilitiesData } from "@/lib/api-client";
import { useReaStore } from "@/store/rea-store";
import { SectionCard, TiltCard, toastError } from "@/components/rea/shared";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export function CapabilitiesView() {
  const { capabilities, setCapabilities } = useReaStore();
  const [loading, setLoading] = React.useState(!capabilities);
  const [query, setQuery] = React.useState("");

  React.useEffect(() => {
    if (capabilities) return;
    let cancelled = false;
    apiGet<CapabilitiesData>("/api/capabilities")
      .then((res) => {
        if (!cancelled) setCapabilities(res);
      })
      .catch((err) => {
        if (!cancelled) toastError(err, "Could not load capabilities");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [capabilities, setCapabilities]);

  if (loading && !capabilities) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32 w-full bg-zinc-800/50" />
        <Skeleton className="h-24 w-full bg-zinc-800/50" />
        <Skeleton className="h-96 w-full bg-zinc-800/40" />
      </div>
    );
  }

  if (!capabilities) {
    return (
      <Alert variant="destructive" className="border-rose-500/40 bg-rose-500/10">
        <AlertTitle>Capabilities unavailable</AlertTitle>
        <AlertDescription>
          The engine capability endpoint could not be reached. Try refreshing the view.
        </AlertDescription>
      </Alert>
    );
  }

  const q = query.trim().toLowerCase();
  const tools = capabilities.tools.filter((t) =>
    q
      ? t.name.toLowerCase().includes(q) ||
        t.title.toLowerCase().includes(q) ||
        (t.description ?? "").toLowerCase().includes(q)
      : true
  );
  const lspLanguages = capabilities.lsp ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-zinc-100">Engine capabilities</h2>
        <p className="text-sm text-zinc-500">
          What the REA engine can do in this deployment — the exact tool surface it exposes over MCP.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <TiltCard maxTilt={3} className="h-full">
          <SectionCard
            title="Engine health"
            description="rea-agents MCP stdio server"
            icon={PlugZap}
            className="h-full"
          >
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant="outline"
                  className={
                    capabilities.engine.healthy
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400 rea-glow-emerald"
                      : "border-rose-500/30 bg-rose-500/10 text-rose-400"
                  }
                >
                  <span className={"size-1.5 rounded-full " + (capabilities.engine.healthy ? "bg-emerald-400" : "bg-rose-400")} aria-hidden />
                  {capabilities.engine.healthy ? "Healthy" : "Unhealthy"}
                </Badge>
                <span className="font-mono text-xs text-zinc-400">v{capabilities.engine.version}</span>
                <span className="font-mono text-xs text-zinc-500 tabular-nums">
                  {capabilities.engine.toolCount} tools
                </span>
              </div>
              {capabilities.engine.detail && (
                <p className="text-xs leading-relaxed text-zinc-500">{capabilities.engine.detail}</p>
              )}
            </div>
          </SectionCard>
        </TiltCard>

        <TiltCard maxTilt={3} className="h-full">
          <SectionCard title="Host tools" description="External analyzers the host machine provides to the engine" icon={Wrench} className="h-full">
            <div className="flex flex-wrap gap-2">
              {capabilities.hostTools.map((tool) => (
                <Badge
                  key={tool.name}
                  variant="outline"
                  className={
                    tool.available
                      ? "gap-1 border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                      : "gap-1 border-zinc-700 bg-zinc-800/60 text-zinc-500 line-through"
                  }
                >
                  {tool.name}
                  <span className="text-[10px]">{tool.available ? "available" : "missing"}</span>
                </Badge>
              ))}
            </div>
          </SectionCard>
        </TiltCard>

        <TiltCard maxTilt={3} className="h-full lg:col-span-2">
          <SectionCard
            title="Code intelligence (LSP)"
            description="Language servers the workspace agent can drive for diagnostics, definitions, references and hovers — chosen by file extension"
            icon={Code2}
            className="h-full"
          >
            {lspLanguages.length === 0 ? (
              <p className="text-xs text-zinc-500">LSP availability could not be probed.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {lspLanguages.map((lang) => (
                  <Badge
                    key={lang.language}
                    variant="outline"
                    className={
                      lang.available
                        ? "gap-1 border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                        : "gap-1 border-zinc-700 bg-zinc-800/60 text-zinc-500"
                    }
                  >
                    <span className={"size-1.5 rounded-full " + (lang.available ? "bg-emerald-400" : "bg-zinc-600")} aria-hidden />
                    {lang.language}
                    <span className="font-mono text-[10px] opacity-75">{lang.server}</span>
                    <span className="text-[10px]">{lang.available ? "ready" : "not installed"}</span>
                  </Badge>
                ))}
              </div>
            )}
            <p className="mt-3 text-xs leading-relaxed text-zinc-500">
              Servers spawn lazily per workspace, one per language, and shut down after 10 minutes idle. The agent&apos;s
              lsp_* tools report exactly which server answered — and refuse honestly when none is installed.
            </p>
          </SectionCard>
        </TiltCard>
      </div>

      <Alert className="border-amber-500/30 bg-amber-500/5">
        <Info className="size-4 text-amber-400" aria-hidden />
        <AlertTitle className="text-amber-400">Why are native providers unavailable?</AlertTitle>
        <AlertDescription className="text-xs leading-relaxed text-zinc-400">
          {capabilities.providers.reason}
        </AlertDescription>
      </Alert>

      <SectionCard
        title="Tool catalog"
        description={q ? `${tools.length} of ${capabilities.tools.length} tools match “${query}”` : `${capabilities.tools.length} REA tools available via MCP`}
        icon={Puzzle}
        actions={
          <div className="relative">
            <Search className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-zinc-500" aria-hidden />
            <Input
              aria-label="Search tool catalog"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search 170 tools…"
              className="h-8 w-44 border-zinc-700 bg-zinc-950 pl-7 font-mono text-xs sm:w-64"
            />
          </div>
        }
        contentClassName="p-0!"
      >
        <div className="rea-scroll max-h-[55vh] overflow-auto rounded-b-lg">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-zinc-900">
              <TableRow className="border-zinc-800 hover:bg-transparent">
                <TableHead className="w-64 text-zinc-500">Tool</TableHead>
                <TableHead className="text-zinc-500">Title</TableHead>
                <TableHead className="hidden text-zinc-500 lg:table-cell">Description</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tools.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="py-8 text-center text-xs text-zinc-500">
                    No tools match “{query}”.
                  </TableCell>
                </TableRow>
              ) : (
                tools.map((tool) => (
                  <TableRow key={tool.name} className="border-zinc-800/70">
                    <TableCell className="font-mono text-xs text-emerald-400">{tool.name}</TableCell>
                    <TableCell className="max-w-[220px] truncate text-xs text-zinc-200">{tool.title}</TableCell>
                    <TableCell className="hidden max-w-md text-xs text-zinc-500 lg:table-cell">
                      <span className="line-clamp-2">{tool.description ?? "—"}</span>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </SectionCard>
    </div>
  );
}
