"use client";

import { RouteError } from "@/components/area/route-chrome";

export default function SettingsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError error={error} reset={reset} label="Settings could not load" />;
}
