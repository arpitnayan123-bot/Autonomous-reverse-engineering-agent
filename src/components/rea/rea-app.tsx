"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Binary,
  BookOpen,
  Heart,
  KeyRound,
  LayoutDashboard,
  Loader2,
  LogOut,
  Menu,
  MessageSquareText,
  PlugZap,
  ShieldCheck,
  Terminal,
} from "lucide-react";

import {
  apiGet,
  apiPost,
  type ProviderCatalog,
  type ReaUser,
} from "@/lib/api-client";
import { useReaStore, type ReaView } from "@/store/rea-store";
import { AuthView } from "@/components/rea/auth-view";
import { CapabilitiesView } from "@/components/rea/capabilities-view";
import { ChatView } from "@/components/rea/chat-view";
import { DashboardView } from "@/components/rea/dashboard-view";
import { DocsView } from "@/components/rea/docs-view";
import { ProviderOnboarding, ProviderSettings } from "@/components/rea/provider-view";
import { SecurityView } from "@/components/rea/security-view";
import { WorkspaceView } from "@/components/rea/workspace-view";
import { toastError } from "@/components/rea/shared";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

const NAV_ITEMS: { view: ReaView; label: string; icon: typeof LayoutDashboard }[] = [
  { view: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { view: "workspace", label: "Workspace", icon: Binary },
  { view: "chat", label: "Chat", icon: MessageSquareText },
  { view: "provider", label: "AI Model", icon: KeyRound },
  { view: "capabilities", label: "Capabilities", icon: PlugZap },
  { view: "security", label: "Security", icon: ShieldCheck },
  { view: "docs", label: "Docs", icon: BookOpen },
];

export function ReaApp() {
  const { booted, user, view, onboarding, hasProviderKey, setView, setUser, setOnboarding } =
    useReaStore();

  // Resolve the session once on boot.
  React.useEffect(() => {
    let cancelled = false;
    apiGet<{ user: ReaUser | null }>("/api/auth/me")
      .then((res) => {
        if (!cancelled) setUser(res.user ?? null);
      })
      .catch(() => {
        // Not signed in (or server unreachable) — show the auth gate.
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) useReaStore.getState().setBooted(true);
      });
    return () => {
      cancelled = true;
    };
  }, [setUser]);

  // Load provider status once per session: drives the first-run onboarding
  // overlay (no key yet → 'provider-setup') and the nav "platform" badge.
  React.useEffect(() => {
    const store = useReaStore.getState();
    if (!user) {
      store.setHasProviderKey(null);
      store.setProviderLoaded(false);
      store.setOnboarding("none");
      return;
    }
    let cancelled = false;
    apiGet<ProviderCatalog>("/api/provider")
      .then((res) => {
        if (cancelled) return;
        const s = useReaStore.getState();
        s.setProviderLoaded(true);
        s.setHasProviderKey(res.active !== null);
        if (res.active === null) {
          // Respect an explicit "skip" from earlier in this browser session.
          const skipped =
            typeof window !== "undefined" &&
            window.sessionStorage.getItem("rea-onboarding-skipped") === "1";
          if (!skipped) s.setOnboarding("provider-setup");
        }
      })
      .catch(() => {
        // Provider endpoint unavailable — platform mode stays unknown.
        if (!cancelled) useReaStore.getState().setProviderLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  const logout = async () => {
    try {
      await apiPost("/api/auth/logout");
    } catch (err) {
      toastError(err, "Logout failed");
    } finally {
      setUser(null);
    }
  };

  if (!booted) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-zinc-950">
        <div className="grid size-10 place-items-center rounded-lg border border-emerald-500/40 bg-emerald-500/10">
          <Terminal className="size-5 text-emerald-400" aria-hidden />
        </div>
        <p className="flex items-center gap-2 font-mono text-xs text-zinc-500">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          booting REA engine…
        </p>
      </div>
    );
  }

  if (!user) {
    return <AuthView onAuthenticated={(u) => setUser(u)} />;
  }

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-zinc-100">
      <Header
        view={view}
        user={user}
        onNavigate={setView}
        onLogout={() => void logout()}
      />

      <main className="relative isolate mx-auto w-full max-w-[1600px] flex-1 px-4 py-6 md:px-6">
        {/* Aurora backdrop — dashboard only, decorative */}
        {view === "dashboard" && <div className="rea-aurora -z-10" aria-hidden />}
        <AnimatePresence mode="wait">
          <motion.div
            key={view}
            initial={{ opacity: 0, y: 16, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -12, scale: 0.99 }}
            transition={{ type: "spring", stiffness: 260, damping: 26 }}
          >
            {view === "dashboard" && <DashboardView />}
            {view === "workspace" && <WorkspaceView />}
            {view === "chat" && <ChatView />}
            {view === "provider" && <ProviderSettings />}
            {view === "capabilities" && <CapabilitiesView />}
            {view === "security" && <SecurityView />}
            {view === "docs" && <DocsView />}
          </motion.div>
        </AnimatePresence>
      </main>

      {/* First-run BYOK onboarding overlay (above everything) */}
      <AnimatePresence>
        {onboarding === "provider-setup" && (
          <ProviderOnboarding
            onDone={() => setOnboarding("none")}
            onSkip={() => {
              try {
                window.sessionStorage.setItem("rea-onboarding-skipped", "1");
              } catch {
                /* storage unavailable — onboarding just reappears */
              }
              setOnboarding("none");
            }}
          />
        )}
      </AnimatePresence>

      <footer className="mt-auto border-t border-zinc-800 bg-zinc-950">
        <div className="mx-auto flex w-full max-w-[1600px] flex-col items-center justify-between gap-2 px-4 py-4 text-xs text-zinc-500 sm:flex-row md:px-6">
          <p className="text-center sm:text-left">
            REA Platform — Reverse Engineer Anything ·{" "}
            <span className="font-mono text-zinc-600">Engine: rea-agents v6.4.0</span> ·{" "}
            <span className="text-emerald-500/80">Evidence-first analysis</span> ·{" "}
            <span className="inline-flex items-center gap-1">
              crafted with
              <Heart
                className="size-3 text-rose-500"
                fill="currentColor"
                aria-hidden
              />
              <span className="sr-only">love</span>
              for reverse engineers
            </span>
          </p>
          <nav aria-label="Footer" className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => setView("docs")}
              className="transition-colors hover:text-emerald-400 focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none"
            >
              Docs
            </button>
            <button
              type="button"
              onClick={() => setView("security")}
              className="transition-colors hover:text-emerald-400 focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none"
            >
              Security
            </button>
          </nav>
        </div>
      </footer>
    </div>
  );
}

function Header({
  view,
  user,
  onNavigate,
  onLogout,
}: {
  view: ReaView;
  user: ReaUser;
  onNavigate: (view: ReaView) => void;
  onLogout: () => void;
}) {
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const hasProviderKey = useReaStore((s) => s.hasProviderKey);

  const initials = user.name
    .split(/\s+/)
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  /** Amber dot on "AI Model" while running in platform mode (no key yet). */
  const navDot = (itemView: ReaView) =>
    itemView === "provider" && hasProviderKey === false ? (
      <span
        className="size-1.5 rounded-full bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.8)]"
        aria-hidden
      />
    ) : null;

  return (
    <header className="sticky top-0 z-40 border-b border-zinc-800 bg-zinc-950/85 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-[1600px] items-center gap-3 px-4 md:px-6">
        {/* Logo mark */}
        <button
          type="button"
          onClick={() => onNavigate("dashboard")}
          className="flex items-center gap-2.5 rounded-md px-1 py-1 focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none"
          aria-label="REA Platform home"
        >
          <span className="grid size-8 place-items-center rounded-md border border-emerald-500/40 bg-emerald-500/10">
            <Terminal className="size-4 text-emerald-400" aria-hidden />
          </span>
          <span className="text-left leading-tight">
            <span className="block font-mono text-sm font-bold tracking-widest text-zinc-100">REA</span>
            <span className="hidden text-[10px] text-zinc-500 sm:block">Reverse Engineer Anything</span>
          </span>
        </button>

        {/* Desktop nav */}
        <nav aria-label="Primary" className="ml-6 hidden items-center gap-1 md:flex">
          {NAV_ITEMS.map(({ view: itemView, label, icon: Icon }) => (
            <button
              key={itemView}
              type="button"
              onClick={() => onNavigate(itemView)}
              aria-current={view === itemView ? "page" : undefined}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none",
                view === itemView
                  ? "border border-emerald-500/25 bg-emerald-500/10 text-emerald-400"
                  : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100"
              )}
            >
              <Icon className="size-3.5" aria-hidden />
              {label}
              {navDot(itemView)}
            </button>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          {/* User menu */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                className="gap-2 px-2 text-zinc-300 hover:bg-zinc-900 hover:text-zinc-100"
                aria-label={`Account menu for ${user.name}`}
              >
                <span className="grid size-6 place-items-center rounded-full border border-emerald-500/40 bg-emerald-500/10 font-mono text-[10px] text-emerald-400">
                  {initials || "U"}
                </span>
                <span className="hidden max-w-[140px] truncate text-xs sm:block">{user.name}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52 border-zinc-800 bg-zinc-900">
              <DropdownMenuLabel className="space-y-0.5">
                <p className="flex items-center gap-1.5 truncate text-xs text-zinc-200">
                  {user.name}
                  {user.isDemo && (
                    <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1 font-mono text-[9px] tracking-wider text-emerald-400">
                      DEMO
                    </span>
                  )}
                </p>
                <p className="truncate font-mono text-[11px] text-zinc-500">{user.email}</p>
              </DropdownMenuLabel>
              <DropdownMenuSeparator className="bg-zinc-800" />
              <DropdownMenuItem
                onClick={() => onNavigate("provider")}
                className="gap-2"
              >
                <KeyRound className="size-3.5" aria-hidden />
                AI Model settings
                {hasProviderKey === false && (
                  <span className="ml-auto font-mono text-[9px] tracking-wider text-amber-400">
                    PLATFORM
                  </span>
                )}
              </DropdownMenuItem>
              <DropdownMenuSeparator className="bg-zinc-800" />
              <DropdownMenuItem
                onClick={onLogout}
                className="gap-2 text-rose-400 focus:bg-rose-500/10 focus:text-rose-300"
              >
                <LogOut className="size-3.5" aria-hidden />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Mobile nav trigger */}
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open navigation menu">
                <Menu className="size-5" aria-hidden />
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-72 border-zinc-800 bg-zinc-950">
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2 font-mono text-sm text-zinc-100">
                  <Terminal className="size-4 text-emerald-400" aria-hidden />
                  REA navigation
                </SheetTitle>
              </SheetHeader>
              <nav aria-label="Mobile" className="flex flex-1 flex-col gap-1 px-3">
                {NAV_ITEMS.map(({ view: itemView, label, icon: Icon }) => (
                  <button
                    key={itemView}
                    type="button"
                    onClick={() => {
                      onNavigate(itemView);
                      setMobileOpen(false);
                    }}
                    aria-current={view === itemView ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-2.5 rounded-md px-3 py-2.5 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none",
                      view === itemView
                        ? "border border-emerald-500/25 bg-emerald-500/10 text-emerald-400"
                        : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100"
                    )}
                  >
                    <Icon className="size-4" aria-hidden />
                    {label}
                    {navDot(itemView)}
                  </button>
                ))}
              </nav>
              <div className="border-t border-zinc-800 p-3">
                <button
                  type="button"
                  onClick={() => {
                    setMobileOpen(false);
                    onLogout();
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-rose-400 transition-colors hover:bg-rose-500/10 focus-visible:ring-2 focus-visible:ring-rose-500/50 focus-visible:outline-none"
                >
                  <LogOut className="size-4" aria-hidden />
                  Sign out
                </button>
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  );
}
