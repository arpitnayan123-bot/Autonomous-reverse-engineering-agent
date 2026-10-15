"use client";

import { RouteError } from "@/components/rea/route-chrome";

export default function SettingsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError error={error} reset={reset} label="Settings could not load" />;
}
