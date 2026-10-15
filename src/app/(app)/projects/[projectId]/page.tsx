import type { Metadata } from "next";
import { PlatformView } from "@/components/area/platform-view";
import { clipTitle, fetchRouteTitle } from "@/lib/meta";

interface Props {
  params: Promise<{ projectId: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { projectId } = await params;
  const title = await fetchRouteTitle(
    `/api/projects/${encodeURIComponent(projectId)}`,
    (json) => {
      const project = json.project as { name?: string } | undefined;
      return project?.name ?? null;
    }
  );
  return {
    title: title ? `Project: ${clipTitle(title)}` : "Project detail",
    description:
      "Pipeline, workspace and knowledge graph for one AREA investigation project.",
  };
}

export default async function ProjectDetailPage({ params }: Props) {
  const { projectId } = await params;
  return (
    <div className="relative min-w-0 flex-1">
      <PlatformView projectId={projectId} />
    </div>
  );
}
