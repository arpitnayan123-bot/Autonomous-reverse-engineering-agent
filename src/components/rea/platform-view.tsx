"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Globe, Github, FileArchive, Plus, Radar, RefreshCw,
  Boxes, Plug, ChevronRight, Loader2,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  platformApi, type ProjectSummary,
} from "@/lib/platform-client";
import { toastError } from "@/components/rea/shared";
import { PlatformProject } from "@/components/rea/platform-project";
import { PlatformConnectors } from "@/components/rea/platform-connectors";

/**
 * Universal Platform workspace — the DISCOVER→VERIFY pipeline over projects
 * (websites, GitHub repos, uploaded targets), plus the connector registry.
 * Lives inside the REA shell as a sibling of the chat workspace.
 */

export function PlatformView({ projectId }: { projectId?: string } = {}) {
  const router = useRouter();
  const [projects, setProjects] = React.useState<ProjectSummary[] | null>(null);
  /**
   * Multi-route refactor: the selected project lives in the URL
   * (/projects/[projectId]); only the connectors pane stays component-local
   * (reachable from any project page via /projects#connectors).
   */
  const [showConnectors, setShowConnectors] = React.useState(false);
  const [createOpen, setCreateOpen] = React.useState(false);

  // Deep link: /projects#connectors opens the connector registry directly.
  React.useEffect(() => {
    if (typeof window !== "undefined" && window.location.hash === "#connectors") {
      setShowConnectors(true);
    }
  }, []);

  const refresh = React.useCallback(async () => {
    try {
      const list = await platformApi.listProjects();
      setProjects(list);
      return list;
    } catch (err) {
      toastError(err, "Could not load projects");
      setProjects([]);
      return [];
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const openProject = (id: string) => router.push(`/projects/${id}`);

  return (
    <div className="flex h-full min-h-0 w-full">
      {/* ============================ Left rail ============================ */}
      <aside className="hidden w-72 shrink-0 flex-col overflow-hidden border-r border-zinc-800/80 bg-zinc-950 md:flex">
        <div className="flex h-11 shrink-0 items-center justify-between border-b border-zinc-800/80 px-3">
          <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-zinc-500">
            <Radar className="size-3.5 text-emerald-500" aria-hidden />
            Universal Platform
          </span>
          <Button
            variant="ghost" size="icon"
            className="size-6 text-zinc-500 hover:text-emerald-400"
            aria-label="Refresh projects"
            onClick={() => void refresh()}
          >
            <RefreshCw className="size-3.5" aria-hidden />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto rea-scroll p-2">
          {/* New project */}
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="group mb-2 flex w-full items-center gap-2 rounded-lg border border-dashed border-zinc-700/80 px-3 py-2.5 text-left transition-colors hover:border-emerald-500/50 hover:bg-emerald-500/5 focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none"
          >
            <span className="grid size-6 place-items-center rounded-md bg-emerald-500/10 text-emerald-400">
              <Plus className="size-3.5" aria-hidden />
            </span>
            <span className="text-xs font-medium text-zinc-300 group-hover:text-emerald-200">
              New investigation
            </span>
          </button>

          {projects === null ? (
            <div className="flex items-center justify-center py-8 text-zinc-600">
              <Loader2 className="size-4 animate-spin" aria-hidden />
            </div>
          ) : projects.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs leading-relaxed text-zinc-600">
              No projects yet. Create an investigation for a website, a GitHub
              repository, or an uploaded file and run the full pipeline.
            </p>
          ) : (
            <ul className="space-y-1" aria-label="Projects">
              {projects.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => openProject(p.id)}
                    aria-current={projectId === p.id}
                    className={`group w-full rounded-lg px-2.5 py-2 text-left transition-colors focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none ${
                      projectId === p.id
                        ? "bg-emerald-500/10 ring-1 ring-emerald-500/30"
                        : "hover:bg-zinc-900"
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <ProjectKindIcon kind={p.kind} />
                      <span className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-200">
                        {p.name}
                      </span>
                      <ChevronRight className="size-3 shrink-0 text-zinc-600 transition-transform group-hover:translate-x-0.5 group-hover:text-emerald-400" aria-hidden />
                    </span>
                    <span className="mt-0.5 block truncate font-mono text-[10px] text-zinc-600">
                      {p.reference}
                    </span>
                    <span className="mt-1 flex flex-wrap items-center gap-1">
                      <CountChip label="pages" n={p.counts.pages} />
                      <CountChip label="nodes" n={p.counts.nodes} />
                      {p.lastOrchestration && (
                        <OrchestrationPill status={p.lastOrchestration.status} progress={p.lastOrchestration.progress} />
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Bottom: connectors */}
        <div className="shrink-0 border-t border-zinc-800/80 p-2">
          <button
            type="button"
            onClick={() => (projectId ? router.push("/projects#connectors") : setShowConnectors(true))}
            className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none ${
              showConnectors && !projectId
                ? "bg-emerald-500/10 text-emerald-200 ring-1 ring-emerald-500/30"
                : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
            }`}
          >
            <Plug className="size-3.5" aria-hidden />
            Connectors
            <span className="ml-auto font-mono text-[10px] text-zinc-600">MCP · HTTP</span>
          </button>
        </div>
      </aside>

      {/* ============================ Main panel ============================ */}
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        {projectId ? (
          <PlatformProject
            key={projectId}
            projectId={projectId}
            onDeleted={() => {
              router.push("/projects");
              void refresh();
            }}
          />
        ) : showConnectors ? (
          <PlatformConnectors />
        ) : (
          <PlatformWelcome onCreate={() => setCreateOpen(true)} projectCount={projects?.length ?? 0} />
        )}

        {/* Mobile project switcher (rail hidden <md) */}
        <div className="absolute top-2 right-2 left-2 z-30 flex items-center gap-2 md:hidden">
          <Select
            value={projectId ?? (showConnectors ? "connectors" : "welcome")}
            onValueChange={(v) => {
              if (v === "welcome") {
                setShowConnectors(false);
                if (projectId) router.push("/projects");
              } else if (v === "connectors") {
                if (projectId) router.push("/projects#connectors");
                else setShowConnectors(true);
              } else openProject(v);
            }}
          >
            <SelectTrigger size="sm" className="h-8 border-zinc-800 bg-zinc-900/90 font-mono text-[11px] text-zinc-300 backdrop-blur" aria-label="Switch platform view">
              <SelectValue placeholder="Platform view" />
            </SelectTrigger>
            <SelectContent className="border-zinc-800 bg-zinc-950">
              <SelectItem value="welcome">Overview</SelectItem>
              <SelectItem value="connectors">Connectors</SelectItem>
              {(projects ?? []).map((p) => (
                <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" className="h-8 border-zinc-700 text-zinc-300" onClick={() => setCreateOpen(true)}>
            <Plus className="size-3.5" aria-hidden /> New
          </Button>
        </div>
      </div>

      <CreateProjectDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(id) => {
          setCreateOpen(false);
          void refresh().then(() => openProject(id));
        }}
      />
    </div>
  );
}

// --- Sub-components ---------------------------------------------------------

function ProjectKindIcon({ kind }: { kind: string }) {
  if (kind === "github") return <Github className="size-3.5 shrink-0 text-zinc-400" aria-hidden />;
  if (kind === "file") return <FileArchive className="size-3.5 shrink-0 text-amber-400" aria-hidden />;
  return <Globe className="size-3.5 shrink-0 text-emerald-400" aria-hidden />;
}

function CountChip({ label, n }: { label: string; n: number }) {
  if (n === 0) return null;
  return (
    <span className="rounded bg-zinc-800/80 px-1.5 py-0.5 font-mono text-[9px] text-zinc-400">
      {n} {label}
    </span>
  );
}

function OrchestrationPill({ status, progress }: { status: string; progress: number }) {
  const map: Record<string, string> = {
    running: "bg-emerald-500/15 text-emerald-300",
    completed: "bg-emerald-500/10 text-emerald-400",
    failed: "bg-red-500/15 text-red-400",
    cancelled: "bg-zinc-700/40 text-zinc-400",
    awaiting_approval: "bg-amber-500/15 text-amber-300",
  };
  return (
    <span className={`rounded px-1.5 py-0.5 font-mono text-[9px] ${map[status] ?? "bg-zinc-800 text-zinc-400"}`}>
      {status === "running" ? `▶ ${progress}%` : status.replace("_", " ")}
    </span>
  );
}

const STAGES = ["DISCOVER", "COLLECT", "UNDERSTAND", "MAP", "RESEARCH", "PLAN", "BUILD", "TEST", "VERIFY"] as const;

function PlatformWelcome({ onCreate, projectCount }: { onCreate: () => void; projectCount: number }) {
  return (
    <div className="relative flex h-full flex-col items-center justify-center overflow-y-auto rea-scroll p-6">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_60%_40%_at_50%_0%,rgba(16,185,129,0.08),transparent)]"
      />
      <div className="relative max-w-2xl text-center">
        <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-[10px] font-medium tracking-wide text-emerald-300">
          <Boxes className="mr-1 size-3" aria-hidden />
          Universal Software Intelligence &amp; Reconstruction
        </Badge>
        <h1 className="mt-4 text-2xl font-semibold tracking-tight text-zinc-100 sm:text-3xl">
          One pipeline from <span className="bg-gradient-to-r from-emerald-400 to-teal-300 bg-clip-text text-transparent">discovery to verified reconstruction</span>
        </h1>
        <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-zinc-400">
          Create a project for any public website, GitHub repository, or uploaded
          file. REA crawls it, parses its source, maps the architecture, researches
          the ecosystem, plans a reconstruction, scaffolds code in an isolated
          workspace, and verifies the result — every finding tagged with its evidence level.
        </p>

        {/* Pipeline stage strip */}
        <div className="mt-6 flex flex-wrap items-center justify-center gap-1" aria-label="Pipeline stages">
          {STAGES.map((s, i) => (
            <React.Fragment key={s}>
              {i > 0 && <ChevronRight className="size-3 text-zinc-700" aria-hidden />}
              <span className="rounded-md border border-zinc-800 bg-zinc-900/80 px-2 py-1 font-mono text-[10px] tracking-wide text-zinc-400">
                {s}
              </span>
            </React.Fragment>
          ))}
        </div>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Button onClick={onCreate} className="bg-emerald-600 text-white hover:bg-emerald-500">
            <Plus className="size-4" aria-hidden />
            New investigation
          </Button>
        </div>

        {projectCount === 0 && (
          <p className="mt-6 font-mono text-[10px] text-zinc-600">
            Tip: “Research this product, map its website, analyze its architecture,
            reconstruct the core flow, and test the result.”
          </p>
        )}
      </div>
    </div>
  );
}

// --- Create dialog -----------------------------------------------------------

function CreateProjectDialog({
  open, onOpenChange, onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (projectId: string) => void;
}) {
  const [kind, setKind] = React.useState<"website" | "github" | "file">("website");
  const [name, setName] = React.useState("");
  const [reference, setReference] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  // Reset when opened.
  React.useEffect(() => {
    if (open) {
      setName(""); setReference(""); setDescription("");
      setKind("website");
    }
  }, [open]);

  const submit = async () => {
    if (busy) return;
    if (!name.trim() || !reference.trim()) {
      toast.error("A name and reference are required");
      return;
    }
    setBusy(true);
    try {
      const r = await platformApi.createProject({
        name: name.trim(),
        kind,
        reference: reference.trim(),
        description: description.trim() || undefined,
      });
      toast.success("Project created");
      onCreated(r.project.id);
    } catch (err) {
      toastError(err, "Could not create project");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-zinc-800 bg-zinc-950 sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-zinc-100">New investigation</DialogTitle>
          <DialogDescription className="text-zinc-500">
            The pipeline adapts to the project kind: websites are crawled,
            repositories are materialized and parsed, files are analyzed.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Project kind">
            {([
              { id: "website", label: "Website", icon: <Globe className="size-3.5" aria-hidden /> },
              { id: "github", label: "GitHub", icon: <Github className="size-3.5" aria-hidden /> },
              { id: "file", label: "Binary/file", icon: <FileArchive className="size-3.5" aria-hidden /> },
            ] as const).map((k) => (
              <button
                key={k.id}
                type="button"
                role="radio"
                aria-checked={kind === k.id}
                onClick={() => setKind(k.id)}
                className={`flex items-center justify-center gap-1.5 rounded-lg border px-2 py-2 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none ${
                  kind === k.id
                    ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300"
                    : "border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-zinc-700"
                }`}
              >
                {k.icon}
                {k.label}
              </button>
            ))}
          </div>
          <label className="block">
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-zinc-500">Name</span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Stripe Docs"
              className="border-zinc-800 bg-zinc-900 text-sm"
            />
          </label>
          <label className="block">
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-zinc-500">
              {kind === "website" ? "Site URL" : kind === "github" ? "owner/repo or GitHub URL" : "Upload reference (targets/<id>)"}
            </span>
            <Input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder={kind === "website" ? "https://example.com" : kind === "github" ? "vercel/next.js" : "targets/…"}
              className="border-zinc-800 bg-zinc-900 font-mono text-sm"
            />
            {kind === "file" && (
              <span className="mt-1 block text-[10px] leading-relaxed text-zinc-600">
                Upload the file in the chat workspace first, then paste its target
                reference here — the pipeline will analyze it in an isolated workspace.
              </span>
            )}
          </label>
          <label className="block">
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-zinc-500">Goal (optional)</span>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What should the reconstruction or analysis achieve?"
              rows={2}
              className="resize-none border-zinc-800 bg-zinc-900 text-sm"
            />
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} className="text-zinc-400">Cancel</Button>
          <Button onClick={() => void submit()} disabled={busy} className="bg-emerald-600 text-white hover:bg-emerald-500">
            {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
            Create project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Shared small bits used by the sibling platform components.
export function KindBadge({ kind }: { kind: string }) {
  const map: Record<string, { cls: string; label: string }> = {
    website: { cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300", label: "website" },
    github: { cls: "border-zinc-600 bg-zinc-800 text-zinc-300", label: "github" },
    file: { cls: "border-amber-500/40 bg-amber-500/10 text-amber-300", label: "file" },
  };
  const v = map[kind] ?? { cls: "border-zinc-700 bg-zinc-900 text-zinc-400", label: kind };
  return <Badge variant="outline" className={`text-[9px] uppercase tracking-wide ${v.cls}`}>{v.label}</Badge>;
}
