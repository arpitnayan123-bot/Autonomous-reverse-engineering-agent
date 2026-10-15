"use client";

import * as React from "react";
import {
  Plug, Plus, Loader2, Trash2, FlaskConical, Zap, CheckCircle2, XCircle, ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  platformApi, type ConnectorView, type BuiltinView,
} from "@/lib/platform-client";
import { toastError, timeAgo } from "@/components/area/shared";

/**
 * Universal Connector System UI — builtins, user HTTP/MCP connectors, health
 * tests, invocation with JSON input, and registration. Header secrets are
 * sealed server-side (AES-256-GCM); the client only ever sees "configured".
 */

export function PlatformConnectors() {
  const [builtins, setBuiltins] = React.useState<BuiltinView[]>([]);
  const [connectors, setConnectors] = React.useState<ConnectorView[] | null>(null);
  const [addOpen, setAddOpen] = React.useState(false);
  const [invokeTarget, setInvokeTarget] = React.useState<ConnectorView | null>(null);

  const load = React.useCallback(async () => {
    try {
      const r = await platformApi.listConnectors();
      setBuiltins(r.builtins);
      setConnectors(r.connectors);
    } catch (err) {
      toastError(err, "Could not load connectors");
      setConnectors([]);
    }
  }, []);

  React.useEffect(() => { void load(); }, [load]);

  const test = async (c: ConnectorView) => {
    try {
      const r = await platformApi.testConnector(c.id);
      if (r.result.ok) {
        toast.success(`${c.name}: ${r.result.detail}`, {
          description: r.result.tools?.length ? `tools: ${r.result.tools.slice(0, 6).map((t) => t.name).join(", ")}` : undefined,
        });
      } else {
        toast.error(`${c.name}: ${r.result.detail}`);
      }
      await load();
    } catch (err) {
      toastError(err, "Test failed");
    }
  };

  const remove = async (c: ConnectorView) => {
    try {
      await platformApi.deleteConnector(c.id);
      toast.success(`${c.name} removed`);
      await load();
    } catch (err) {
      toastError(err, "Could not remove connector");
    }
  };

  return (
    <div className="h-full overflow-y-auto area-scroll p-4">
      <div className="mx-auto max-w-3xl space-y-5">
        <div className="flex items-center gap-2">
          <Plug className="size-4 text-emerald-500" aria-hidden />
          <h2 className="text-sm font-semibold text-zinc-100">Connectors</h2>
          <Badge variant="outline" className="border-zinc-800 text-[9px] text-zinc-500">universal connector system</Badge>
          <Button onClick={() => setAddOpen(true)} size="sm" className="ml-auto bg-emerald-600 text-white hover:bg-emerald-500">
            <Plus className="size-3.5" aria-hidden /> Add connector
          </Button>
        </div>
        <p className="text-xs leading-relaxed text-zinc-500">
          Connectors give the pipeline (and your future runs) reusable external
          capabilities: platform built-ins, arbitrary HTTP endpoints (SSRF-guarded),
          and external MCP servers over stdio. Auth headers are encrypted with the
          same vault as provider keys and never displayed again.
        </p>

        {/* Builtins */}
        <section aria-label="Built-in connectors">
          <p className="mb-2 font-mono text-[9px] uppercase tracking-wider text-zinc-500">Built-in (always available)</p>
          <div className="grid gap-2 sm:grid-cols-3">
            {builtins.map((b) => (
              <div key={b.id} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="size-3.5 text-emerald-400" aria-hidden />
                  <span className="text-xs font-medium text-zinc-200">{b.name}</span>
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">{b.description}</p>
                <p className="mt-1.5 truncate font-mono text-[9px] text-zinc-600">{b.inputHint}</p>
              </div>
            ))}
          </div>
        </section>

        {/* User connectors */}
        <section aria-label="Registered connectors">
          <p className="mb-2 font-mono text-[9px] uppercase tracking-wider text-zinc-500">Registered</p>
          {connectors === null ? (
            <div className="grid place-items-center py-6"><Loader2 className="size-4 animate-spin text-zinc-600" aria-hidden /></div>
          ) : connectors.length === 0 ? (
            <p className="rounded-lg border border-dashed border-zinc-800 p-5 text-center text-xs text-zinc-600">
              No external connectors yet. Add an HTTP endpoint or an MCP server
              (stdio commands: node · bun · npx · bunx · python3 · uvx).
            </p>
          ) : (
            <ul className="space-y-2">
              {connectors.map((c) => (
                <li key={c.id} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusDot status={c.status} />
                    <span className="text-xs font-medium text-zinc-200">{c.name}</span>
                    <Badge variant="outline" className="border-zinc-800 text-[9px] uppercase text-zinc-500">{c.kind}</Badge>
                    {c.hasSecrets && (
                      <span className="inline-flex items-center gap-1 font-mono text-[9px] text-emerald-400">
                        <ShieldCheck className="size-3" aria-hidden /> secrets sealed
                      </span>
                    )}
                    <span className="ml-auto flex items-center gap-1">
                      <Button variant="ghost" size="sm" className="h-7 px-2 text-[10px] text-zinc-400 hover:text-emerald-300" onClick={() => void test(c)}>
                        <FlaskConical className="size-3" aria-hidden /> Test
                      </Button>
                      <Button variant="ghost" size="sm" className="h-7 px-2 text-[10px] text-zinc-400 hover:text-emerald-300" onClick={() => setInvokeTarget(c)}>
                        <Zap className="size-3" aria-hidden /> Invoke
                      </Button>
                      <Button variant="ghost" size="icon" className="size-7 text-zinc-600 hover:text-red-400" aria-label={`Remove ${c.name}`} onClick={() => void remove(c)}>
                        <Trash2 className="size-3.5" aria-hidden />
                      </Button>
                    </span>
                  </div>
                  <p className="mt-1 truncate font-mono text-[10px] text-zinc-500">{c.endpoint ?? "—"}</p>
                  <p className="mt-0.5 font-mono text-[9px] text-zinc-600">
                    {c.status === "healthy" ? "healthy" : c.status === "unreachable" ? `last error: ${c.lastError?.slice(0, 120) ?? "unknown"}` : "not tested yet"}
                    {c.lastCheckedAt ? ` · checked ${timeAgo(c.lastCheckedAt)}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <AddConnectorDialog open={addOpen} onOpenChange={setAddOpen} onCreated={() => void load()} />
      <InvokeConnectorDialog connector={invokeTarget} onClose={() => setInvokeTarget(null)} />
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const cls = status === "healthy" ? "bg-emerald-500" : status === "unreachable" ? "bg-red-500" : "bg-zinc-600";
  return <span className={`size-2 shrink-0 rounded-full ${cls}`} aria-label={`status: ${status}`} />;
}

// --- Add dialog -----------------------------------------------------------------

function AddConnectorDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: () => void }) {
  const [kind, setKind] = React.useState<"http" | "mcp">("http");
  const [name, setName] = React.useState("");
  const [endpoint, setEndpoint] = React.useState("");
  const [method, setMethod] = React.useState("POST");
  const [args, setArgs] = React.useState("");
  const [headerName, setHeaderName] = React.useState("authorization");
  const [headerValue, setHeaderValue] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setName(""); setEndpoint(""); setArgs(""); setHeaderValue("");
      setKind("http"); setMethod("POST"); setHeaderName("authorization");
    }
  }, [open]);

  const submit = async () => {
    if (busy) return;
    if (!name.trim() || !endpoint.trim()) {
      toast.error("Name and endpoint are required");
      return;
    }
    setBusy(true);
    try {
      const headers: Record<string, string> = {};
      if (headerName.trim() && headerValue.trim()) headers[headerName.trim()] = headerValue.trim();
      await platformApi.createConnector({
        name: name.trim(),
        kind,
        endpoint: endpoint.trim(),
        headers: Object.keys(headers).length ? headers : undefined,
        config: kind === "http" ? { method } : { args: args.trim() ? args.trim().split(/\s+/) : [] },
      });
      toast.success("Connector registered");
      onCreated();
      onOpenChange(false);
    } catch (err) {
      toastError(err, "Could not register connector");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-zinc-800 bg-zinc-950 sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-zinc-100">Add connector</DialogTitle>
          <DialogDescription className="text-zinc-500">
            HTTP connectors are SSRF-guarded; MCP servers spawn over stdio from an
            allowlisted binary list — never a shell.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Connector kind">
            {(["http", "mcp"] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={kind === k}
                onClick={() => setKind(k)}
                className={`rounded-lg border px-2 py-2 text-xs font-medium uppercase transition-colors ${
                  kind === k ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300" : "border-zinc-800 bg-zinc-900 text-zinc-400"
                }`}
              >
                {k}
              </button>
            ))}
          </div>
          <label className="block">
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-zinc-500">Name</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Team wiki API" className="border-zinc-800 bg-zinc-900 text-sm" />
          </label>
          <label className="block">
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-zinc-500">
              {kind === "http" ? "Endpoint URL" : "MCP command"}
            </span>
            {kind === "http" ? (
              <Input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://api.example.com/…" className="border-zinc-800 bg-zinc-900 font-mono text-sm" />
            ) : (
              <Select value={endpoint} onValueChange={setEndpoint}>
                <SelectTrigger className="border-zinc-800 bg-zinc-900 font-mono text-sm">
                  <SelectValue placeholder="choose binary" />
                </SelectTrigger>
                <SelectContent className="border-zinc-800 bg-zinc-950">
                  {["node", "bun", "npx", "bunx", "python3", "uvx"].map((b) => (
                    <SelectItem key={b} value={b} className="font-mono">{b}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </label>
          {kind === "http" ? (
            <>
              <label className="block">
                <span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-zinc-500">Method</span>
                <Select value={method} onValueChange={setMethod}>
                  <SelectTrigger className="border-zinc-800 bg-zinc-900 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="border-zinc-800 bg-zinc-950">
                    <SelectItem value="POST">POST (JSON body)</SelectItem>
                    <SelectItem value="GET">GET</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              <div className="grid grid-cols-[1fr_1.4fr] gap-2">
                <label className="block">
                  <span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-zinc-500">Header (optional)</span>
                  <Input value={headerName} onChange={(e) => setHeaderName(e.target.value)} className="border-zinc-800 bg-zinc-900 font-mono text-xs" />
                </label>
                <label className="block">
                  <span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-zinc-500">Value (sealed)</span>
                  <Input type="password" value={headerValue} onChange={(e) => setHeaderValue(e.target.value)} placeholder="Bearer …" className="border-zinc-800 bg-zinc-900 font-mono text-xs" />
                </label>
              </div>
            </>
          ) : (
            <label className="block">
              <span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-zinc-500">Args (space-separated)</span>
              <Input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="-y @modelcontextprotocol/server-filesystem /tmp" className="border-zinc-800 bg-zinc-900 font-mono text-xs" />
            </label>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} className="text-zinc-400">Cancel</Button>
          <Button onClick={() => void submit()} disabled={busy} className="bg-emerald-600 text-white hover:bg-emerald-500">
            {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
            Register
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --- Invoke dialog -----------------------------------------------------------------

function InvokeConnectorDialog({ connector, onClose }: { connector: ConnectorView | null; onClose: () => void }) {
  const [input, setInput] = React.useState("{}");
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (connector) {
      setInput("{}");
      setResult(null);
    }
  }, [connector]);

  if (!connector) return null;

  const invoke = async () => {
    setBusy(true);
    setResult(null);
    try {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(input) as Record<string, unknown>;
      } catch {
        toast.error("Input must be valid JSON");
        return;
      }
      const r = await platformApi.invokeConnector(connector.id, parsed);
      setResult(`${r.ok ? "OK" : "FAILED"}${r.kind ? ` (${r.kind})` : ""}\n\n${r.detail}`);
    } catch (err) {
      toastError(err, "Invocation failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="border-zinc-800 bg-zinc-950 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-zinc-100">Invoke {connector.name}</DialogTitle>
          <DialogDescription className="text-zinc-500">
            JSON input sent to the connector ({connector.kind}).
          </DialogDescription>
        </DialogHeader>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={4}
          spellCheck={false}
          aria-label="Connector JSON input"
          className="w-full resize-none rounded-lg border border-zinc-800 bg-zinc-900 p-2.5 font-mono text-xs text-zinc-300 outline-none"
        />
        {result && (
          <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-zinc-800 bg-zinc-950 p-2.5 font-mono text-[10px] leading-relaxed text-zinc-400 area-scroll">
            {result}
          </pre>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} className="text-zinc-400">Close</Button>
          <Button onClick={() => void invoke()} disabled={busy} className="bg-emerald-600 text-white hover:bg-emerald-500">
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Zap className="size-4" aria-hidden />}
            Invoke
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
