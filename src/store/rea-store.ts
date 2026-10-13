"use client";

import { create } from "zustand";
import type { Capabilities, ReaUser, TargetSummary } from "@/lib/api-client";

export type ReaView =
  | "dashboard"
  | "workspace"
  | "chat"
  | "capabilities"
  | "security"
  | "docs";

interface ReaState {
  /** Views rendered client-side; identity resolved once on boot. */
  booted: boolean;
  user: ReaUser | null;
  view: ReaView;
  activeTargetId: string | null;
  targets: TargetSummary[];
  capabilities: Capabilities | null;

  setBooted: (booted: boolean) => void;
  setUser: (user: ReaUser | null) => void;
  setView: (view: ReaView) => void;
  openTarget: (targetId: string) => void;
  setActiveTargetId: (targetId: string | null) => void;
  setTargets: (targets: TargetSummary[]) => void;
  setCapabilities: (capabilities: Capabilities | null) => void;
}

export const useReaStore = create<ReaState>((set) => ({
  booted: false,
  user: null,
  view: "dashboard",
  activeTargetId: null,
  targets: [],
  capabilities: null,

  setBooted: (booted) => set({ booted }),
  setUser: (user) => set({ user }),
  setView: (view) => set({ view }),
  openTarget: (targetId) =>
    set({ activeTargetId: targetId, view: "workspace" }),
  setActiveTargetId: (activeTargetId) => set({ activeTargetId }),
  setTargets: (targets) => set({ targets }),
  setCapabilities: (capabilities) => set({ capabilities }),
}));
