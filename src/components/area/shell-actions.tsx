"use client";

import * as React from "react";

/**
 * Actions the route-level client components need from the surrounding shell
 * (sidebar refreshers, upload picker). Provided by AppShell so that pages
 * rendered as route children (which live in their own route folders) can
 * reach shell-owned behaviour without prop drilling through server wrappers.
 */
export interface ShellActions {
  /** Re-fetch chat sessions into the sidebar. */
  refreshSessions(): void;
  /** Re-fetch targets/files into the sidebar. */
  refreshTargets(): void;
  /** Open the shell's file-picker upload flow. */
  openUploadPicker(): void;
}

const noop: ShellActions = {
  refreshSessions: () => undefined,
  refreshTargets: () => undefined,
  openUploadPicker: () => undefined,
};

const ShellActionsContext = React.createContext<ShellActions>(noop);

export function ShellActionsProvider({
  value,
  children,
}: {
  value: ShellActions;
  children: React.ReactNode;
}) {
  return <ShellActionsContext.Provider value={value}>{children}</ShellActionsContext.Provider>;
}

export function useShellActions(): ShellActions {
  return React.useContext(ShellActionsContext);
}
