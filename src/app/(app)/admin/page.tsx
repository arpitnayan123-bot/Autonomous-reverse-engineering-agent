import type { Metadata } from "next";
import { AdminView } from "@/components/area/admin-view";

/** /admin — the operations console (tenant-isolated audit + posture). */
export const metadata: Metadata = {
  title: "Operations console",
  description:
    "AREA operations: account posture, live sessions and the per-user audit trail. Platform APIs are tenant-isolated by design.",
};

export default function AdminPage() {
  return <AdminView />;
}
