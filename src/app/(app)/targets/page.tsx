import type { Metadata } from "next";
import { TargetsList } from "@/components/rea/targets-list";

/** /targets — all uploaded targets with their latest analysis run. */
export const metadata: Metadata = {
  title: "Targets",
  description:
    "Uploaded binaries, databases and app bundles under REA investigation — evidence, findings and analysis runs.",
};

export default function TargetsPage() {
  return <TargetsList />;
}
