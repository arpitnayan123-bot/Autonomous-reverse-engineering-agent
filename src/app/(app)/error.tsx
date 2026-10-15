"use client";

import { RouteError } from "@/components/rea/route-chrome";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError error={error} reset={reset} label="REA hit an error" />;
}
