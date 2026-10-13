"use client";

import { create } from "zustand";
import type {
  Capabilities,
  ProviderActive,
  ReaUser,
  SessionSummary,
  TargetSummary,
} from "@/lib/api-client";

/** Global dialogs (Cursor-style — nothing is a separate "page"). */
export type ReaDialog = "none" | "settings" | "system";

interface ReaState {
  booted: boolean;
  user: ReaUser | null;

  /** Chat sessions for the sidebar. */
  sessions: SessionSummary[];
  sessionsLoaded: boolean;
  /** Active session id; null = a draft (not-yet-persisted) chat. */
  activeSessionId: string | null;
  /** Target bound to the draft chat (first send creates the session). */
  draftTargetId: string | null;

  /** Files (targets) for the sidebar. */
  targets: TargetSummary[];
  targetsLoaded: boolean;
  /** Right-side inspector panel state. */
  inspectorTargetId: string | null;
  inspectorOpen: boolean;

  /** Desktop sidebar visibility (⌘B). */
  sidebarOpen: boolean;
  /** ⌘K command palette. */
  paletteOpen: boolean;
  /** Scroll-to + flash-highlight this message after the session loads (search jump). */
  jumpToMessageId: string | null;

  capabilities: Capabilities | null;

  /** Global dialogs. */
  dialog: ReaDialog;
  /** Active BYOK provider (null = platform model). */
  providerActive: ProviderActive | null;
  providerLoaded: boolean;
  hasProviderKey: boolean | null;
  /** Message quota from the last chat POST (X-RateLimit headers). */
  chatQuota: { limit: number; remaining: number } | null;
  /** Cumulative provider-reported tokens for the active session (null = none known). */
  sessionTokens: { tokensIn: number; tokensOut: number } | null;

  setBooted: (booted: boolean) => void;
  setUser: (user: ReaUser | null) => void;

  setSessions: (sessions: SessionSummary[]) => void;
  setSessionsLoaded: (loaded: boolean) => void;
  /** Continue an existing session. */
  openSession: (sessionId: string) => void;
  /** Start a fresh free chat (no file attached). */
  newFreeChat: () => void;
  /** Start a fresh draft chat bound to a target file. */
  newTargetChat: (targetId: string) => void;
  setActiveSessionId: (id: string | null) => void;
  setDraftTargetId: (id: string | null) => void;

  setTargets: (targets: TargetSummary[]) => void;
  setTargetsLoaded: (loaded: boolean) => void;
  openInspector: (targetId: string) => void;
  closeInspector: () => void;
  setInspectorOpen: (open: boolean) => void;

  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  setPaletteOpen: (open: boolean) => void;
  /** Queue a scroll-to + highlight of a message once the session renders. */
  requestJumpToMessage: (messageId: string) => void;
  clearJumpToMessage: () => void;

  setCapabilities: (capabilities: Capabilities | null) => void;

  setDialog: (dialog: ReaDialog) => void;
  setProviderActive: (active: ProviderActive | null) => void;
  setProviderLoaded: (loaded: boolean) => void;
  setHasProviderKey: (has: boolean | null) => void;
  setChatQuota: (quota: { limit: number; remaining: number } | null) => void;
  setSessionTokens: (tokens: { tokensIn: number; tokensOut: number } | null) => void;
}

export const useReaStore = create<ReaState>((set) => ({
  booted: false,
  user: null,

  sessions: [],
  sessionsLoaded: false,
  activeSessionId: null,
  draftTargetId: null,

  targets: [],
  targetsLoaded: false,
  inspectorTargetId: null,
  inspectorOpen: false,

  sidebarOpen: true,
  paletteOpen: false,
  jumpToMessageId: null,

  capabilities: null,

  dialog: "none",
  providerActive: null,
  providerLoaded: false,
  hasProviderKey: null,
  chatQuota: null,
  sessionTokens: null,

  setBooted: (booted) => set({ booted }),
  setUser: (user) => set({ user }),

  setSessions: (sessions) => set({ sessions }),
  setSessionsLoaded: (sessionsLoaded) => set({ sessionsLoaded }),
  openSession: (sessionId) =>
    set({ activeSessionId: sessionId, draftTargetId: null }),
  newFreeChat: () => set({ activeSessionId: null, draftTargetId: null }),
  newTargetChat: (targetId) =>
    set({ activeSessionId: null, draftTargetId: targetId }),
  setActiveSessionId: (activeSessionId) => set({ activeSessionId }),
  setDraftTargetId: (draftTargetId) => set({ draftTargetId }),

  setTargets: (targets) => set({ targets }),
  setTargetsLoaded: (targetsLoaded) => set({ targetsLoaded }),
  openInspector: (inspectorTargetId) =>
    set({ inspectorTargetId, inspectorOpen: true }),
  closeInspector: () => set({ inspectorOpen: false }),
  setInspectorOpen: (inspectorOpen) => set({ inspectorOpen }),

  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  requestJumpToMessage: (jumpToMessageId) => set({ jumpToMessageId }),
  clearJumpToMessage: () => set({ jumpToMessageId: null }),

  setCapabilities: (capabilities) => set({ capabilities }),

  setDialog: (dialog) => set({ dialog }),
  setProviderActive: (providerActive) => set({ providerActive }),
  setProviderLoaded: (providerLoaded) => set({ providerLoaded }),
  setHasProviderKey: (hasProviderKey) => set({ hasProviderKey }),
  setChatQuota: (chatQuota) => set({ chatQuota }),
  setSessionTokens: (sessionTokens) => set({ sessionTokens }),
}));
