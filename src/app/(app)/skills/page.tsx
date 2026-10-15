import type { Metadata } from "next";
import { SkillsView } from "@/components/rea/skills-view";

/** /skills — the community skills marketplace (Capability C5). */
export const metadata: Metadata = {
  title: "Skills",
  description:
    "REA community skills marketplace: checksummed rea-skill manifests, declared tool permissions, and sandboxed runs with full audit trails.",
};

export default function SkillsPage() {
  return <SkillsView />;
}
