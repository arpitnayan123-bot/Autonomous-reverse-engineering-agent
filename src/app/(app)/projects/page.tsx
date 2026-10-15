import type { Metadata } from "next";
import { PlatformView } from "@/components/area/platform-view";

/** /projects — project list (pipeline workspaces, knowledge graphs, reports). */
export const metadata: Metadata = {
  title: "Projects",
  description:
    "AREA universal platform: investigations over websites, GitHub repositories and uploaded files — crawl, research, build and verify.",
};

export default function ProjectsPage() {
  return (
    <div className="relative min-w-0 flex-1">
      <PlatformView />
    </div>
  );
}
