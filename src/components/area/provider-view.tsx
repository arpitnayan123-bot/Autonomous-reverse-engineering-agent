"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  BadgeCheck,
  Check,
  ChevronLeft,
  Eye,
  EyeOff,
  ExternalLink,
  KeyRound,
  Loader2,
  PlugZap,
  ShieldCheck,
  Trash2,
  TriangleAlert,
} from "lucide-react";

import {
  apiDelete,
  apiGet,
  apiPost,
  type ProviderActive,
  type ProviderInfo,
} from "@/lib/api-client";
import { useReaStore } from "@/store/area-store";
import {
  SectionCard,
  TiltCard,
  timeAgo,
  toastError,
} from "@/components/area/shared";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Provider visual identity (BYOK catalog: openai | anthropic | gemini |
// deepseek | kimi | glm — keyed defensively, unknown ids get a fallback).
// ---------------------------------------------------------------------------

const PROVIDER_STYLE: Record<string, { mono: string; className: string }> = {
  openai: {
    mono: "OP",
    className: "border-zinc-500/40 bg-gradient-to-br from-zinc-700/70 to-zinc-900 text-zinc-100",
  },
  anthropic: {
    mono: "AN",
    className: "border-orange-500/40 bg-gradient-to-br from-orange-600/60 to-orange-950/60 text-orange-200",
  },
  gemini: {
    mono: "GE",
    className: "border-blue-500/40 bg-gradient-to-br from-blue-600/60 to-indigo-950/60 text-blue-200",
  },
  deepseek: {
    mono: "DE",
    className: "border-violet-500/40 bg-gradient-to-br from-violet-600/60 to-purple-950/60 text-violet-200",
  },
  kimi: {
    mono: "KI",
    className: "border-cyan-500/40 bg-gradient-to-br from-cyan-600/60 to-sky-950/60 text-cyan-200",
  },
  glm: {
    mono: "GL",
    className: "border-teal-500/40 bg-gradient-to-br from-teal-600/60 to-emerald-950/60 text-teal-200",
  },
};

function providerStyle(id: string) {
  return PROVIDER_STYLE[id] ?? { mono: id.slice(0, 2).toUpperCase(), className: "border-zinc-600/50 bg-zinc-800 text-zinc-200" };
}

function ProviderMonogram({ id, size = "md" }: { id: string; size?: "sm" | "md" }) {
  const style = providerStyle(id);
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center rounded-lg border font-mono font-bold tracking-wider",
        style.className,
        size === "md" ? "size-10 text-xs" : "size-7 text-[10px]"
      )}
    >
      {style.mono}
    </span>
  );
}

function providerLabel(providers: ProviderInfo[], id: string): string {
  return providers.find((p) => p.id === id)?.label ?? id;
}

// ---------------------------------------------------------------------------
// Key flow — pick provider → enter key → pick model → verify & save.
// Shared by the first-run onboarding overlay and the settings replace-form.
// ---------------------------------------------------------------------------

type FlowStep = "provider" | "key" | "model";

function KeyFlow({
  providers,
  submitLabel,
  onSaved,
  className,
}: {
  providers: ProviderInfo[];
  submitLabel: string;
  onSaved: (active: ProviderActive) => void;
  className?: string;
}) {
  const [step, setStep] = React.useState<FlowStep>("provider");
  const [providerId, setProviderId] = React.useState<string | null>(null);
  const [apiKey, setApiKey] = React.useState("");
  const [showKey, setShowKey] = React.useState(false);
  const [model, setModel] = React.useState<string | null>(null);
  const [verifying, setVerifying] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const provider = providers.find((p) => p.id === providerId) ?? null;

  const pickProvider = (id: string) => {
    setProviderId(id);
    setApiKey("");
    setModel(null);
    setError(null);
    setStep("key");
  };

  const submitKey = () => {
    const trimmed = apiKey.trim();
    if (trimmed.length < 16 || trimmed.length > 400) {
      setError("API key looks invalid (expected 16–400 characters).");
      return;
    }
    setError(null);
    setModel(provider?.models[0]?.id ?? null);
    setStep("model");
  };

  const verifyAndSave = async () => {
    if (!providerId || !model || verifying) return;
    setVerifying(true);
    setError(null);
    try {
      const res = await apiPost<{ active: ProviderActive }>("/api/provider", {
        provider: providerId,
        apiKey: apiKey.trim(),
        model,
        verify: true,
      });
      onSaved(res.active);
    } catch (err) {
      // 400 responses carry the provider's real verification error.
      setError(err instanceof Error ? err.message : "Key verification failed.");
      setVerifying(false);
    }
  };

  const STEP_LABELS: { id: FlowStep; label: string }[] = [
    { id: "provider", label: "Provider" },
    { id: "key", label: "API key" },
    { id: "model", label: "Model" },
  ];
  const stepIndex = STEP_LABELS.findIndex((s) => s.id === step);

  return (
    <div className={cn("space-y-4", className)}>
      {/* Step rail */}
      <ol className="flex items-center gap-2" aria-label="Setup steps">
        {STEP_LABELS.map((s, i) => (
          <li key={s.id} className="flex items-center gap-2">
            <span
              aria-current={s.id === step ? "step" : undefined}
              className={cn(
                "flex items-center gap-1.5 font-mono text-[10px] tracking-widest uppercase",
                i < stepIndex && "text-emerald-500",
                i === stepIndex && "text-emerald-300",
                i > stepIndex && "text-zinc-600"
              )}
            >
              <span
                className={cn(
                  "grid size-4 place-items-center rounded-full border text-[9px]",
                  i < stepIndex && "border-emerald-500/50 bg-emerald-500/15 text-emerald-400",
                  i === stepIndex && "border-emerald-400/60 bg-emerald-500/20 text-emerald-300",
                  i > stepIndex && "border-zinc-700 text-zinc-600"
                )}
              >
                {i < stepIndex ? <Check className="size-2.5" aria-hidden /> : i + 1}
              </span>
              {s.label}
            </span>
            {i < STEP_LABELS.length - 1 && <span className="h-px w-4 bg-zinc-800" aria-hidden />}
          </li>
        ))}
      </ol>

      <AnimatePresence mode="wait" initial={false}>
        {step === "provider" && (
          <motion.div
            key="step-provider"
            initial={{ opacity: 0, x: 14 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -14 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="space-y-3"
          >
            <div
              role="radiogroup"
              aria-label="Choose your AI provider"
              className="grid grid-cols-2 gap-2.5 sm:grid-cols-3"
            >
              {providers.map((p) => (
                <TiltCard key={p.id} maxTilt={7} className="min-w-0">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={providerId === p.id}
                    onClick={() => pickProvider(p.id)}
                    className="group relative flex h-full w-full flex-col items-start gap-2 rounded-lg border border-zinc-800 bg-zinc-950/70 p-3 text-left transition-colors hover:border-emerald-500/40 hover:bg-emerald-500/5 focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none data-[state=selected]:border-emerald-500/50"
                  >
                    <span className="flex w-full items-center gap-2">
                      <ProviderMonogram id={p.id} />
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-semibold text-zinc-100">{p.label}</span>
                        <span className="block truncate font-mono text-[10px] text-zinc-500">{p.vendor}</span>
                      </span>
                    </span>
                  </button>
                </TiltCard>
              ))}
            </div>
          </motion.div>
        )}

        {step === "key" && provider && (
          <motion.div
            key="step-key"
            initial={{ opacity: 0, x: 14 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -14 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="space-y-3"
          >
            <div className="flex items-center gap-2.5 rounded-lg border border-zinc-800 bg-zinc-950/70 p-3">
              <ProviderMonogram id={provider.id} size="sm" />
              <div className="min-w-0 text-xs">
                <p className="font-semibold text-zinc-100">{provider.label}</p>
                <p className="truncate font-mono text-[10px] text-zinc-500">{provider.docsHint}</p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="ml-auto h-7 gap-1 px-2 text-[11px] text-zinc-400 hover:text-zinc-100"
                onClick={() => setStep("provider")}
              >
                <ChevronLeft className="size-3.5" aria-hidden />
                Change
              </Button>
            </div>
            <div className="space-y-2">
              <Label htmlFor={`flow-key-${provider.id}`}>{provider.label} API key</Label>
              <div className="relative">
                <Input
                  id={`flow-key-${provider.id}`}
                  type={showKey ? "text" : "password"}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={provider.docsHint.split(" ")[0] + "…"}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      submitKey();
                    }
                  }}
                  className="border-zinc-800 bg-zinc-950 pr-10 font-mono text-sm"
                  disabled={verifying}
                />
                <button
                  type="button"
                  aria-label={showKey ? "Hide API key" : "Show API key"}
                  onClick={() => setShowKey((v) => !v)}
                  className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-zinc-500 hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none"
                >
                  {showKey ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
                </button>
              </div>
              <p className="text-[11px] text-zinc-600">
                Encrypted at rest (AES-256-GCM) — never leaves the server, scrubbed from logs.
              </p>
            </div>
            <Button
              type="button"
              onClick={submitKey}
              disabled={verifying || apiKey.trim().length < 16}
              className="w-full bg-emerald-600 text-white hover:bg-emerald-500"
            >
              Continue
            </Button>
          </motion.div>
        )}

        {step === "model" && provider && (
          <motion.div
            key="step-model"
            initial={{ opacity: 0, x: 14 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -14 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="space-y-3"
          >
            <div
              role="radiogroup"
              aria-label={`Choose a ${provider.label} model`}
              className="grid gap-2"
            >
              {provider.models.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={model === m.id}
                  onClick={() => setModel(m.id)}
                  className={cn(
                    "flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none",
                    model === m.id
                      ? "border-emerald-500/50 bg-emerald-500/10"
                      : "border-zinc-800 bg-zinc-950/70 hover:border-zinc-700 hover:bg-zinc-900/70"
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "grid size-4 shrink-0 place-items-center rounded-full border",
                      model === m.id ? "border-emerald-400" : "border-zinc-600"
                    )}
                  >
                    {model === m.id && <span className="size-2 rounded-full bg-emerald-400" />}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium text-zinc-100">{m.label}</span>
                    <span className="block truncate font-mono text-[10px] text-zinc-500">
                      {m.id}
                      {m.note ? ` · ${m.note}` : ""}
                    </span>
                  </span>
                </button>
              ))}
            </div>
            {error && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 p-3"
              >
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-rose-400" aria-hidden />
                <p className="text-xs leading-relaxed text-rose-300">{error}</p>
              </div>
            )}
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                className="border-zinc-700 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
                onClick={() => setStep("key")}
                disabled={verifying}
              >
                <ChevronLeft className="size-4" aria-hidden />
                Back
              </Button>
              <Button
                type="button"
                onClick={() => void verifyAndSave()}
                disabled={!model || verifying}
                className="flex-1 bg-emerald-600 text-white hover:bg-emerald-500"
              >
                {verifying && <Loader2 className="size-4 animate-spin" aria-hidden />}
                {verifying ? "Verifying…" : submitLabel}
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ProviderOnboarding — full-screen first-run overlay.
// ---------------------------------------------------------------------------

export function ProviderOnboarding({
  onDone,
  onSkip,
}: {
  onDone: () => void;
  onSkip: () => void;
}) {
  const [catalog, setCatalog] = React.useState<ProviderInfo[] | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    apiGet<{ providers: ProviderInfo[] }>("/api/provider")
      .then((res) => {
        if (!cancelled) setCatalog(res.providers);
      })
      .catch((err) => {
        if (!cancelled) {
          setCatalog([]);
          toastError(err, "Could not load provider catalog");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-zinc-950/85 p-4 backdrop-blur-md sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label="Connect your AI model"
    >
      <div className="area-aurora" aria-hidden />
      <motion.div
        initial={{ opacity: 0, y: 24, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 16, scale: 0.98 }}
        transition={{ type: "spring", stiffness: 260, damping: 26 }}
        className="area-glass relative z-10 my-auto w-full max-w-2xl space-y-5 rounded-xl p-5 sm:p-7"
      >
        <header className="space-y-1.5">
          <div className="flex items-center gap-2.5">
            <span className="grid size-9 place-items-center rounded-lg border border-emerald-500/40 bg-emerald-500/10 area-glow-emerald">
              <KeyRound className="size-4.5 text-emerald-400" aria-hidden />
            </span>
            <h2 className="text-base font-semibold text-zinc-100">Connect your AI model</h2>
          </div>
          <p className="max-w-xl text-xs leading-relaxed text-zinc-400">
            AREA runs on a platform-provided GLM model by default. Bring your own key to
            investigate with your preferred provider — the key is encrypted at rest
            (AES-256-GCM), never leaves the server and is scrubbed from logs.
          </p>
        </header>

        {catalog === null ? (
          <div className="space-y-3" aria-label="Loading provider catalog">
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-[74px] rounded-lg bg-zinc-800/60" />
              ))}
            </div>
            <p className="flex items-center gap-2 font-mono text-[11px] text-zinc-500">
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              loading provider catalog…
            </p>
          </div>
        ) : (
          <KeyFlow
            providers={catalog}
            submitLabel="Verify & save"
            onSaved={() => onDone()}
          />
        )}

        <footer className="flex flex-col items-center gap-1 border-t border-zinc-800/80 pt-4">
          <button
            type="button"
            onClick={onSkip}
            className="rounded text-xs text-zinc-500 underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-emerald-400 hover:decoration-emerald-500/50 focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none"
          >
            Skip for now — use the platform model (GLM)
          </button>
          <p className="text-[11px] text-zinc-600">You can add a key anytime from AI Model settings.</p>
        </footer>
      </motion.div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// ProviderSettings — the "AI Model" settings view.
// ---------------------------------------------------------------------------

export function ProviderSettings() {
  const { setHasProviderKey } = useReaStore();
  const [providers, setProviders] = React.useState<ProviderInfo[] | null>(null);
  const [active, setActive] = React.useState<ProviderActive | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [testing, setTesting] = React.useState(false);
  const [flowOpen, setFlowOpen] = React.useState(false);
  const [confirmRemove, setConfirmRemove] = React.useState(false);
  const [removing, setRemoving] = React.useState(false);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiGet<{ providers: ProviderInfo[]; active: ProviderActive | null }>(
        "/api/provider"
      );
      setProviders(res.providers);
      setActive(res.active);
      setHasProviderKey(res.active !== null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load provider settings.");
    } finally {
      setLoading(false);
    }
  }, [setHasProviderKey]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const testConnection = async () => {
    if (testing) return;
    setTesting(true);
    try {
      const res = await apiPutTest();
      toast({
        title: "Connection OK",
        description: `${providerLabel(providers ?? [], res.provider)} · ${res.model} replied “${res.reply || "ok"}”`,
      });
    } catch (err) {
      toastError(err, "Connection test failed");
    } finally {
      setTesting(false);
    }
  };

  const removeKey = async () => {
    setRemoving(true);
    try {
      await apiDelete("/api/provider");
      setActive(null);
      setHasProviderKey(false);
      setFlowOpen(false);
      toast({ title: "Key removed", description: "Falling back to the platform-provided GLM model." });
    } catch (err) {
      toastError(err, "Could not remove key");
    } finally {
      setRemoving(false);
      setConfirmRemove(false);
    }
  };

  if (loading && providers === null) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-36 w-full bg-zinc-800/50" />
        <Skeleton className="h-64 w-full bg-zinc-800/50" />
      </div>
    );
  }

  if (loadError) {
    return (
      <SectionCard
        title="AI model"
        description="Bring your own key (BYOK) or use the platform model"
        icon={KeyRound}
      >
        <div role="alert" className="space-y-3">
          <p className="text-xs text-rose-300">{loadError}</p>
          <Button
            variant="outline"
            size="sm"
            className="border-zinc-700 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
            onClick={() => void refresh()}
          >
            Retry
          </Button>
        </div>
      </SectionCard>
    );
  }

  const activeProviderLabel = active ? providerLabel(providers ?? [], active.provider) : null;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-zinc-100">AI model</h2>
        <p className="text-sm text-zinc-500">
          The model that powers chat and documentation synthesis. Bring your own key (BYOK)
          or ride the platform-provided GLM.
        </p>
      </div>

      {/* Current configuration ------------------------------------------- */}
      <TiltCard maxTilt={3}>
        <SectionCard
          title="Active configuration"
          description={
            active
              ? "Investigations run through your own provider key"
              : "Platform mode — no key configured"
          }
          icon={PlugZap}
          actions={
            active ? (
              <Button
                variant="outline"
                size="sm"
                className="h-8 border-emerald-500/40 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 hover:text-emerald-300"
                onClick={() => void testConnection()}
                disabled={testing}
              >
                {testing ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <PlugZap className="size-3.5" aria-hidden />}
                Test connection
              </Button>
            ) : (
              <Button
                size="sm"
                className="h-8 bg-emerald-600 text-white hover:bg-emerald-500"
                onClick={() => setFlowOpen(true)}
              >
                <KeyRound className="size-3.5" aria-hidden />
                Add your key
              </Button>
            )
          }
        >
          {active ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <span className="flex items-center gap-2.5">
                <ProviderMonogram id={active.provider} />
                <span>
                  <span className="block text-sm font-semibold text-zinc-100">{activeProviderLabel}</span>
                  <span className="block font-mono text-[11px] text-zinc-500">{active.model}</span>
                </span>
              </span>
              <Badge variant="outline" className="gap-1 border-zinc-700 bg-zinc-950 font-mono text-[11px] text-zinc-300">
                <KeyRound className="size-3 text-emerald-500" aria-hidden />
                ••••{active.keyLast4 ?? "····"}
              </Badge>
              <Badge
                variant="outline"
                className={
                  active.verified
                    ? "gap-1 border-emerald-500/30 bg-emerald-500/10 text-emerald-400 area-glow-emerald"
                    : "gap-1 border-amber-500/30 bg-amber-500/10 text-amber-400"
                }
              >
                <BadgeCheck className="size-3" aria-hidden />
                {active.verified ? "verified" : "unverified"}
              </Badge>
              <span className="text-[11px] text-zinc-600">
                updated {timeAgo(typeof active.updatedAt === "string" ? active.updatedAt : null)}
              </span>
            </div>
          ) : (
            <p className="text-xs leading-relaxed text-zinc-400">
              Chats and generated docs run on the platform-provided{" "}
              <span className="font-mono text-emerald-400">GLM</span> model. Add your own key to use
              OpenAI, Anthropic, Gemini, DeepSeek, Kimi or GLM with your own account.
            </p>
          )}
        </SectionCard>
      </TiltCard>

      {/* Replace / add key ------------------------------------------------ */}
      <SectionCard
        title={active ? "Replace API key" : "Add an API key"}
        description="Pick a provider, paste the key, choose a model — we verify it live before saving."
        icon={KeyRound}
        actions={
          active && (
            <div className="flex items-center gap-2">
              {!flowOpen && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 border-zinc-700 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
                  onClick={() => setFlowOpen(true)}
                >
                  Replace key
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                className="h-8 border-rose-500/40 bg-rose-500/5 text-rose-400 hover:bg-rose-500/15 hover:text-rose-300"
                onClick={() => setConfirmRemove(true)}
              >
                <Trash2 className="size-3.5" aria-hidden />
                Remove key
              </Button>
            </div>
          )
        }
      >
        {providers === null ? (
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-[74px] rounded-lg bg-zinc-800/60" />
            ))}
          </div>
        ) : !flowOpen ? (
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
            {providers.map((p) => (
              <div
                key={p.id}
                className="flex items-center gap-2.5 rounded-lg border border-zinc-800 bg-zinc-950/70 p-3"
              >
                <ProviderMonogram id={p.id} size="sm" />
                <span className="min-w-0 text-xs">
                  <span className="block truncate font-semibold text-zinc-200">{p.label}</span>
                  <span className="block truncate font-mono text-[10px] text-zinc-500">{p.vendor}</span>
                </span>
              </div>
            ))}
            <p className="col-span-full text-[11px] text-zinc-600">
              {active
                ? "The stored key is never shown again — replace it to switch provider or model."
                : "Pick a provider above or click “Add your key” to start."}
            </p>
          </div>
        ) : (
          <KeyFlow
            providers={providers}
            submitLabel="Verify & save"
            onSaved={(next) => {
              setActive(next);
              setHasProviderKey(true);
              setFlowOpen(false);
              toast({
                title: "Provider connected",
                description: `${providerLabel(providers, next.provider)} · ${next.model} verified — you're on your own key now.`,
              });
            }}
          />
        )}
      </SectionCard>

      {/* Security note ---------------------------------------------------- */}
      <SectionCard
        title="How your key is stored"
        description="BYOK security posture"
        icon={ShieldCheck}
        className="area-card-shine"
      >
        <ul className="space-y-2 text-xs leading-relaxed text-zinc-400">
          <li className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-emerald-500" aria-hidden />
            Encrypted at rest with <span className="font-mono text-zinc-200">AES-256-GCM</span> — the
            plaintext key is never persisted.
          </li>
          <li className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-emerald-500" aria-hidden />
            The key <span className="text-zinc-200">never leaves the server</span> and is never
            returned to the browser — only the last 4 characters are shown.
          </li>
          <li className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-emerald-500" aria-hidden />
            Secrets are <span className="text-zinc-200">scrubbed from logs</span> and error traces;
            verification failures report provider errors without the key.
          </li>
          <li className="flex items-start gap-2">
            <ExternalLink className="mt-0.5 size-3.5 shrink-0 text-zinc-600" aria-hidden />
            Calls go directly from this server to your provider — no third-party relay.
          </li>
        </ul>
      </SectionCard>

      {/* Remove confirmation ---------------------------------------------- */}
      <AlertDialog open={confirmRemove} onOpenChange={(open) => !open && setConfirmRemove(false)}>
        <AlertDialogContent className="border-zinc-800 bg-zinc-900">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-zinc-100">Remove provider key?</AlertDialogTitle>
            <AlertDialogDescription className="text-zinc-400">
              The encrypted key is deleted from the server and cannot be recovered. Chat and
              documentation will fall back to the platform-provided GLM model.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-zinc-700 bg-transparent text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-600 text-white hover:bg-rose-500"
              disabled={removing}
              onClick={(e) => {
                e.preventDefault();
                void removeKey();
              }}
            >
              {removing && <Loader2 className="size-4 animate-spin" aria-hidden />}
              Remove key
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** PUT /api/provider — ping the currently configured model. */
async function apiPutTest(): Promise<{ source: string; provider: string; model: string; reply: string }> {
  const res = await fetch("/api/provider", { method: "PUT", cache: "no-store" });
  let json: { ok?: boolean; error?: string } & Record<string, unknown> | null = null;
  try {
    json = (await res.json()) as { ok?: boolean; error?: string } & Record<string, unknown>;
  } catch {
    json = null;
  }
  if (!res.ok || !json || json.ok !== true) {
    const msg =
      (json && typeof json.error === "string" && json.error) ||
      `Connection test failed (${res.status})`;
    throw new Error(msg);
  }
  return {
    source: typeof json.source === "string" ? json.source : "platform",
    provider: typeof json.provider === "string" ? json.provider : "unknown",
    model: typeof json.model === "string" ? json.model : "unknown",
    reply: typeof json.reply === "string" ? json.reply : "",
  };
}
