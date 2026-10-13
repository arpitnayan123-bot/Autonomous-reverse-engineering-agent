"use client";

import * as React from "react";
import Script from "next/script";
import { motion } from "framer-motion";
import {
  Cpu,
  Eye,
  EyeOff,
  FileSearch,
  Loader2,
  ShieldCheck,
  Sparkles,
  Terminal,
} from "lucide-react";

import { apiPost, type ReaUser } from "@/lib/api-client";
import { TiltCard, toastError } from "@/components/rea/shared";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/** Custom element provided by thrine.app embed runtime. */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace React.JSX {
    interface IntrinsicElements {
      "model-embed": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & { project?: string },
        HTMLElement
      >;
    }
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const HERO_POINTS = [
  { icon: FileSearch, text: "Upload a binary, artifact, database or app — REA detects what it is." },
  { icon: Cpu, text: "The real REA engine investigates it with 170 evidence-first MCP tools." },
  { icon: ShieldCheck, text: "Every conclusion is backed by an observed/derived/inferred evidence ledger." },
];

const THRINE_EMBED_SRC = "https://thrine.app/embed/v1.js";
const THRINE_PROJECT = "e_e9e6387b451eb0a1c456";

/**
 * 3D model showcase embed (thrine.app). Loads the module runtime once and
 * renders the declarative <model-embed> custom element.
 */
function ThrineModelEmbed() {
  return (
    <div
      className="relative flex w-full max-w-xl items-center justify-center"
      aria-label="Interactive 3D model showcase"
    >
      {/* soft glow behind the embed */}
      <div
        className="pointer-events-none absolute inset-0 -z-0 rounded-full bg-emerald-500/10 blur-[80px]"
        aria-hidden
      />
      <div className="relative z-10 w-full [filter:drop-shadow(0_24px_48px_rgba(0,0,0,0.55))]">
        <model-embed
          project={THRINE_PROJECT}
          style={{ display: "block", width: "100%", aspectRatio: "372 / 98" }}
        />
      </div>
      <Script src={THRINE_EMBED_SRC} type="module" strategy="afterInteractive" />
    </div>
  );
}

export function AuthView({ onAuthenticated }: { onAuthenticated: (user: ReaUser) => void }) {
  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-zinc-950">
      {/* Aurora backdrop — auth view only, decorative */}
      <div className="rea-aurora -z-0" aria-hidden />

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: "easeOut" }}
        className="relative z-10 mx-auto grid w-full max-w-6xl flex-1 items-center gap-8 px-4 py-10 lg:grid-cols-[1.1fr_1fr] lg:gap-12 lg:py-14"
      >
        {/* ------------------------------------------------ hero (left on desktop,
            compact banner on mobile) ------------------------------------ */}
        <section
          aria-label="REA Platform introduction"
          className="flex min-w-0 flex-col items-center gap-6 text-center lg:items-start lg:gap-8 lg:text-left"
        >
          <div className="space-y-3">
            <div className="mx-auto grid size-12 place-items-center rounded-lg border border-emerald-500/40 bg-emerald-500/10 rea-glow-emerald lg:mx-0">
              <Terminal className="size-6 text-emerald-400" aria-hidden />
            </div>
            <h1 className="font-mono text-2xl font-bold tracking-tight text-zinc-100 lg:text-3xl">
              REA <span className="text-emerald-400">Platform</span>
            </h1>
            <p className="mx-auto max-w-lg text-sm leading-relaxed text-zinc-400 lg:mx-0">
              Professional reverse engineering, as easy as chatting with an AI.
              Upload a binary, artifact, database or app — the REA engine
              investigates it with evidence-backed rigor.
            </p>
          </div>

          {/* 3D model showcase — thrine embed (compact banner on mobile) */}
          <div className="flex w-full items-center justify-center sm:min-h-[220px] lg:min-h-[300px]">
            <ThrineModelEmbed />
          </div>

          <ul className="hidden w-full max-w-md space-y-2 text-left lg:block">
            {HERO_POINTS.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-start gap-2 text-xs text-zinc-500">
                <Icon className="mt-0.5 size-3.5 shrink-0 text-emerald-500" aria-hidden />
                <span>{text}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* ------------------------------------------------ auth card ------- */}
        <section aria-label="Sign in" className="w-full max-w-md justify-self-center lg:justify-self-end">
          <TiltCard maxTilt={4}>
            <Card className="rea-glass border-white/5 shadow-lg shadow-black/40">
              <CardHeader>
                <CardTitle className="text-base text-zinc-100">Sign in to your workspace</CardTitle>
                <CardDescription className="text-xs">
                  Accounts are local to this deployment. Sessions are HttpOnly cookie-based.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Tabs defaultValue="signin">
                  <TabsList className="grid w-full grid-cols-2 bg-zinc-950">
                    <TabsTrigger value="signin">Sign in</TabsTrigger>
                    <TabsTrigger value="register">Create account</TabsTrigger>
                  </TabsList>
                  <TabsContent value="signin">
                    <SigninForm onAuthenticated={onAuthenticated} />
                  </TabsContent>
                  <TabsContent value="register">
                    <RegisterForm onAuthenticated={onAuthenticated} />
                  </TabsContent>
                </Tabs>

                {/* One-click demo */}
                <div className="mt-4 border-t border-zinc-800/80 pt-4">
                  <DemoButton onAuthenticated={onAuthenticated} />
                </div>
              </CardContent>
            </Card>
          </TiltCard>

          <p className="mt-6 text-center text-[11px] text-zinc-600">
            Evidence-first analysis · Uploads are parsed read-only, never executed.
          </p>
        </section>
      </motion.div>
    </div>
  );
}

function DemoButton({ onAuthenticated }: { onAuthenticated: (user: ReaUser) => void }) {
  const [busy, setBusy] = React.useState(false);

  const tryDemo = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await apiPost<{ user: ReaUser }>("/api/auth/demo");
      onAuthenticated(res.user);
      // Auth gate unmounts this view on success — no busy reset needed.
    } catch (err) {
      toastError(err, "Demo sign-in failed");
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="secondary"
        disabled={busy}
        onClick={() => void tryDemo()}
        aria-label="Enter the shared demo workspace"
        className="w-full gap-2 border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 transition-all hover:bg-emerald-500/20 hover:text-emerald-200 hover:shadow-[0_0_24px_rgba(16,185,129,0.25)] focus-visible:ring-emerald-500/50"
      >
        {busy ? (
          <Loader2 className="size-4 animate-spin" aria-hidden />
        ) : (
          <Sparkles className="size-4" aria-hidden />
        )}
        ✦ Try the demo workspace
      </Button>
      <p className="text-center text-[11px] text-zinc-600">
        Shared temporary workspace — data may be reset.
      </p>
    </div>
  );
}

function SigninForm({ onAuthenticated }: { onAuthenticated: (user: ReaUser) => void }) {
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [showPassword, setShowPassword] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!EMAIL_RE.test(email)) return setError("Enter a valid email address.");
    if (password.length < 1) return setError("Enter your password.");
    setBusy(true);
    try {
      const res = await apiPost<{ user: ReaUser }>("/api/auth/login", { email, password });
      onAuthenticated(res.user);
    } catch (err) {
      toastError(err, "Sign in failed");
      setError(err instanceof Error ? err.message : "Sign in failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="mt-4 space-y-4" noValidate>
      {error && (
        <Alert variant="destructive" className="border-rose-500/40 bg-rose-500/10">
          <AlertDescription className="text-xs text-rose-300">{error}</AlertDescription>
        </Alert>
      )}
      <div className="space-y-2">
        <Label htmlFor="signin-email">Email</Label>
        <Input
          id="signin-email"
          type="email"
          autoComplete="email"
          placeholder="analyst@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="border-zinc-800 bg-zinc-950 font-mono text-sm"
          disabled={busy}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="signin-password">Password</Label>
        <div className="relative">
          <Input
            id="signin-password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="border-zinc-800 bg-zinc-950 pr-10 font-mono text-sm"
            disabled={busy}
          />
          <button
            type="button"
            aria-label={showPassword ? "Hide password" : "Show password"}
            onClick={() => setShowPassword((v) => !v)}
            className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-zinc-500 hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none"
          >
            {showPassword ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
          </button>
        </div>
      </div>
      <Button type="submit" disabled={busy} className="w-full bg-emerald-600 text-white hover:bg-emerald-500">
        {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
        Sign in
      </Button>
    </form>
  );
}

function RegisterForm({ onAuthenticated }: { onAuthenticated: (user: ReaUser) => void }) {
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (name.trim().length < 2) return setError("Name must be at least 2 characters.");
    if (!EMAIL_RE.test(email)) return setError("Enter a valid email address.");
    if (password.length < 8) return setError("Password must be at least 8 characters.");
    setBusy(true);
    try {
      const res = await apiPost<{ user: ReaUser }>("/api/auth/register", {
        email: email.trim(),
        password,
        name: name.trim(),
      });
      onAuthenticated(res.user);
    } catch (err) {
      toastError(err, "Registration failed");
      setError(err instanceof Error ? err.message : "Registration failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="mt-4 space-y-4" noValidate>
      {error && (
        <Alert variant="destructive" className="border-rose-500/40 bg-rose-500/10">
          <AlertDescription className="text-xs text-rose-300">{error}</AlertDescription>
        </Alert>
      )}
      <div className="space-y-2">
        <Label htmlFor="register-name">Name</Label>
        <Input
          id="register-name"
          autoComplete="name"
          placeholder="Ada Lovelace"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="border-zinc-800 bg-zinc-950 text-sm"
          disabled={busy}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="register-email">Email</Label>
        <Input
          id="register-email"
          type="email"
          autoComplete="email"
          placeholder="analyst@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="border-zinc-800 bg-zinc-950 font-mono text-sm"
          disabled={busy}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="register-password">Password</Label>
        <Input
          id="register-password"
          type="password"
          autoComplete="new-password"
          placeholder="At least 8 characters"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="border-zinc-800 bg-zinc-950 font-mono text-sm"
          disabled={busy}
        />
        <p className="text-[11px] text-zinc-600">
          Hashed with scrypt; never stored in plain text.
        </p>
      </div>
      <Button type="submit" disabled={busy} className="w-full bg-emerald-600 text-white hover:bg-emerald-500">
        {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
        Create account
      </Button>
    </form>
  );
}
