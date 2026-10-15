"use client";

import { RouteError } from "@/components/area/route-chrome";

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError error={error} reset={reset} label="The operations console hit an error" />;
}
