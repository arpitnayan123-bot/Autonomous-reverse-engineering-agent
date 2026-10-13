"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Binary,
  BookOpen,
  LayoutDashboard,
  Loader2,
  LogOut,
  Menu,
  MessageSquareText,
  PlugZap,
  ShieldCheck,
  Terminal,
} from "lucide-react";

import { apiGet, apiPost, type ReaUser } from "@/lib/api-client";
import { useReaStore, type ReaView } from "@/store/rea-store";
import { AuthView } from "@/components/rea/auth-view";
import { CapabilitiesView } from "@/components/rea/capabilities-view";
import { ChatView } from "@/components/rea/chat-view";
import { DashboardView } from "@/components/rea/dashboard-view";
import { DocsView } from "@/components/rea/docs-view";
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
  { view: "capabilities", label: "Capabilities", icon: PlugZap },
  { view: "security", label: "Security", icon: ShieldCheck },
  { view: "docs", label: "Docs", icon: BookOpen },
];

export function ReaApp() {
  const { booted, user, view, setView, setUser } = useReaStore();

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

      <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-6 md:px-6">
        <AnimatePresence mode="wait">
          <motion.div
            key={view}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
          >
            {view === "dashboard" && <DashboardView />}
            {view === "workspace" && <WorkspaceView />}
            {view === "chat" && <ChatView />}
            {view === "capabilities" && <CapabilitiesView />}
            {view === "security" && <SecurityView />}
            {view === "docs" && <DocsView />}
          </motion.div>
        </AnimatePresence>
      </main>

      <footer className="mt-auto border-t border-zinc-800 bg-zinc-950">
        <div className="mx-auto flex w-full max-w-[1600px] flex-col items-center justify-between gap-2 px-4 py-4 text-xs text-zinc-500 sm:flex-row md:px-6">
          <p className="text-center sm:text-left">
            REA Platform — Reverse Engineer Anything ·{" "}
            <span className="font-mono text-zinc-600">Engine: rea-agents v6.4.0</span> ·{" "}
            <span className="text-emerald-500/80">Evidence-first analysis</span>
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

  const initials = user.name
    .split(/\s+/)
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

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
                <p className="truncate text-xs text-zinc-200">{user.name}</p>
                <p className="truncate font-mono text-[11px] text-zinc-500">{user.email}</p>
              </DropdownMenuLabel>
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
