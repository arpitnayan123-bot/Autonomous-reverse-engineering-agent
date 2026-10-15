import type { Metadata } from "next";
import { TargetPanel } from "@/components/rea/target-panel";
import { clipTitle, fetchRouteTitle } from "@/lib/meta";

interface Props {
  params: Promise<{ targetId: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { targetId } = await params;
  const title = await fetchRouteTitle(
    `/api/targets/${encodeURIComponent(targetId)}`,
    (json) => {
      const target = json.target as { originalName?: string } | undefined;
      return target?.originalName ?? null;
    }
  );
  return {
    title: title ? `Target: ${clipTitle(title)}` : "Target detail",
    description: "Evidence, findings and analysis runs for one REA target.",
  };
}

export default async function TargetDetailPage({ params }: Props) {
  const { targetId } = await params;
  return (
    <div className="min-h-0 w-full flex-1 overflow-y-auto rea-scroll">
      <TargetPanel targetId={targetId} className="mx-auto w-full max-w-5xl" />
    </div>
  );
}
