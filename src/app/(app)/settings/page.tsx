import type { Metadata } from "next";
import { SettingsView } from "@/components/rea/settings-view";

interface Props {
  searchParams: Promise<{ tab?: string }>;
}

/** /settings — providers, security, memory, engine, docs. */
export const metadata: Metadata = {
  title: "Settings",
  description:
    "REA account settings: BYOK providers, security controls and sessions, cross-session memory, engine capabilities and documentation.",
};

export default async function SettingsPage({ searchParams }: Props) {
  const { tab } = await searchParams;
  return <SettingsView initialTab={tab} />;
}
