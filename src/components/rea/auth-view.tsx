"use client";

import * as React from "react";
import Image from "next/image";
import { Eye, EyeOff, Loader2 } from "lucide-react";

import { apiPost, type ReaUser } from "@/lib/api-client";
import { toastError } from "@/components/rea/shared";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Minimal sign-in gate. Deliberately plain: a centered card, nothing else.
 */
export function AuthView({ onAuthenticated }: { onAuthenticated: (user: ReaUser) => void }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-950 px-4">
      <div className="w-full max-w-sm">
        {/* Wordmark */}
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <Image
            src="/rea-logo-256.png"
            alt="REA logo — a deconstructed cube under scan"
            width={64}
            height={64}
            priority
            className="rounded-2xl ring-1 ring-zinc-800 shadow-[0_0_36px_-6px_rgba(16,185,129,0.5)]"
          />
          <div>
            <h1 className="font-mono text-lg font-bold tracking-widest text-zinc-100">REA</h1>
            <p className="mt-1 text-xs text-zinc-500">Autonomous reverse engineering agent</p>
          </div>
        </div>

        <Tabs defaultValue="signin">
          <TabsList className="grid w-full grid-cols-2 bg-zinc-900">
            <TabsTrigger value="signin">Sign in</TabsTrigger>
            <TabsTrigger value="register">Create account</TabsTrigger>
          </TabsList>
          <TabsContent value="signin" className="mt-4">
            <SigninForm onAuthenticated={onAuthenticated} />
          </TabsContent>
          <TabsContent value="register" className="mt-4">
            <RegisterForm onAuthenticated={onAuthenticated} />
          </TabsContent>
        </Tabs>

        <div className="my-5 flex items-center gap-3" aria-hidden>
          <span className="h-px flex-1 bg-zinc-800" />
          <span className="text-[10px] uppercase tracking-wider text-zinc-600">or</span>
          <span className="h-px flex-1 bg-zinc-800" />
        </div>

        <DemoButton onAuthenticated={onAuthenticated} />

        <p className="mt-6 text-center text-[11px] leading-relaxed text-zinc-600">
          Uploads are parsed read-only, never executed.
        </p>
      </div>
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
    <Button
      type="button"
      variant="outline"
      disabled={busy}
      onClick={() => void tryDemo()}
      aria-label="Continue with the demo workspace"
      className="w-full border-zinc-800 bg-zinc-900 text-zinc-200 hover:bg-zinc-800 hover:text-zinc-100"
    >
      {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
      Continue with demo
    </Button>
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
      setBusy(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
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
          className="border-zinc-800 bg-zinc-900 font-mono text-sm"
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
            className="border-zinc-800 bg-zinc-900 pr-10 font-mono text-sm"
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
  const [showPassword, setShowPassword] = React.useState(false);

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
      setBusy(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
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
          className="border-zinc-800 bg-zinc-900 text-sm"
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
          className="border-zinc-800 bg-zinc-900 font-mono text-sm"
          disabled={busy}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="register-password">Password</Label>
        <div className="relative">
          <Input
            id="register-password"
            type={showPassword ? "text" : "password"}
            autoComplete="new-password"
            placeholder="At least 8 characters"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="border-zinc-800 bg-zinc-900 pr-10 font-mono text-sm"
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
        Create account
      </Button>
    </form>
  );
}
