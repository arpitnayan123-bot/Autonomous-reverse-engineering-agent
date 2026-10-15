"use client";

import { RouteError } from "@/components/rea/route-chrome";

export default function TargetDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError error={error} reset={reset} label="This target could not load" />;
}
