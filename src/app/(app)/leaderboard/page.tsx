import type { Metadata } from "next";
import { LeaderboardView } from "@/components/rea/leaderboard-view";

/** /leaderboard — the public verification leaderboard (Capability 4). */
export const metadata: Metadata = {
  title: "Public leaderboard",
  description:
    "REA reconstruction leaderboard: scores measured by the open benchmark harness (OBSERVED) plus cited third-party claims (INFERRED), ranked per agent, benchmark and category.",
};

export default function LeaderboardPage() {
  return <LeaderboardView />;
}
