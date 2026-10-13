'use client'

import dynamic from 'next/dynamic'
import { Loader2 } from 'lucide-react'

// Client-only SPA shell (auth gate + view switching live inside ReaApp).
const ReaApp = dynamic(
  () => import('@/components/rea/rea-app').then((mod) => mod.ReaApp),
  {
    ssr: false,
    loading: () => (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-zinc-950">
        <Loader2 className="size-5 animate-spin text-emerald-400" aria-hidden />
        <p className="font-mono text-xs text-zinc-500">loading REA Platform…</p>
      </div>
    ),
  }
)

export default function Home() {
  return <ReaApp />
}
