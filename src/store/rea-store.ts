"use client";

import { create } from "zustand";
import type { Capabilities, ReaUser, TargetSummary } from "@/lib/api-client";

export type ReaView =
  | "dashboard"
  | "workspace"
  | "chat"
  | "provider"
  | "capabilities"
  | "security"
  | "docs";

export type OnboardingStep = "none" | "provider-setup";

interface ReaState {
  /** Views rendered client-side; identity resolved once on boot. */
  booted: boolean;
  user: ReaUser | null;
  view: ReaView;
  activeTargetId: string | null;
  targets: TargetSummary[];
  capabilities: Capabilities | null;
  /** First-run AI provider onboarding (shown after auth when no key yet). */
  onboarding: OnboardingStep;
  /** Server reached but provider catalog not yet loaded. */
  providerLoaded: boolean;
  /** Whether a BYOK key is configured (null = unknown yet). */
  hasProviderKey: boolean | null;

  setBooted: (booted: boolean) => void;
  setUser: (user: ReaUser | null) => void;
  setView: (view: ReaView) => void;
  openTarget: (targetId: string) => void;
  setActiveTargetId: (targetId: string | null) => void;
  setTargets: (targets: TargetSummary[]) => void;
  setCapabilities: (capabilities: Capabilities | null) => void;
  setOnboarding: (step: OnboardingStep) => void;
  setProviderLoaded: (loaded: boolean) => void;
  setHasProviderKey: (has: boolean | null) => void;
}

export const useReaStore = create<ReaState>((set) => ({
  booted: false,
  user: null,
  view: "dashboard",
  activeTargetId: null,
  targets: [],
  capabilities: null,
  onboarding: "none",
  providerLoaded: false,
  hasProviderKey: null,

  setBooted: (booted) => set({ booted }),
  setUser: (user) => set({ user }),
  setView: (view) => set({ view }),
  openTarget: (targetId) =>
    set({ activeTargetId: targetId, view: "workspace" }),
  setActiveTargetId: (activeTargetId) => set({ activeTargetId }),
  setTargets: (targets) => set({ targets }),
  setCapabilities: (capabilities) => set({ capabilities }),
  setOnboarding: (onboarding) => set({ onboarding }),
  setProviderLoaded: (providerLoaded) => set({ providerLoaded }),
  setHasProviderKey: (hasProviderKey) => set({ hasProviderKey }),
}));
