"use client";

import { RouteError } from "@/components/rea/route-chrome";

export default function ChatSessionError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError error={error} reset={reset} label="This chat session hit an error" />;
}
