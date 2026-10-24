import { useState } from 'react'
import { useFlags, markFlagDismissed } from '@/lib/queries'
import { FlagCard } from '@/components/layout/FlagCard'
import { cn } from '@/lib/utils'
import type { FlagResponse } from '@/types/api'

type Tab = 'active' | 'dismissed'

export default function Flags() {
  const flagsQ = useFlags()
  const flags: FlagResponse[] = flagsQ.data ?? []
  const loading = flagsQ.status === 'pending'
  const [tab, setTab] = useState<Tab>('active')

  // FlagCard has already called the dismiss API by the time this fires.
  const handleDismiss = (id: string) => markFlagDismissed(id)

  const active = flags.filter((f) => !f.dismissed)
  const dismissed = flags.filter((f) => f.dismissed)
  const visible = tab === 'active' ? active : dismissed

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div>
        <h1 className="font-display text-[28px] font-semibold text-ink">Alerts</h1>
        <p className="font-sans text-[14px] text-ink-soft mt-1">
          Risk flags and material events that may affect your portfolio.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-0 border-b border-line" role="tablist">
        {(['active', 'dismissed'] as Tab[]).map((t) => (
          <button
            key={t}
            role="tab"
            type="button"
            onClick={() => setTab(t)}
            aria-selected={tab === t}
            className={cn(
              'px-4 py-2.5 font-mono text-[12px] uppercase tracking-[0.12em] border-b-2 transition-colors -mb-px min-h-[44px]',
              'focus-visible:outline-2 focus-visible:outline-jade focus-visible:outline-offset-2',
              tab === t
                ? 'border-jade text-jade'
                : 'border-transparent text-ink-soft hover:text-ink',
            )}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
            {t === 'active' && active.length > 0 && (
              <span className="ml-1.5 px-1.5 py-0.5 bg-loss text-white font-mono text-[10px] rounded-full">
                {active.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex justify-center py-16">
          <span className="w-6 h-6 rounded-full border-2 border-jade border-t-transparent animate-spin" />
        </div>
      ) : visible.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-20 text-center">
          <p className="font-display text-[20px] font-semibold text-ink-soft">
            {tab === 'active' ? 'All clear' : 'Nothing dismissed yet'}
          </p>
          <p className="font-sans text-[14px] text-ink-faint">
            {tab === 'active'
              ? 'No active alerts for your portfolio right now.'
              : 'Dismissed alerts will appear here.'}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {visible.map((flag) => (
            <FlagCard key={flag.id} flag={flag} onDismiss={handleDismiss} />
          ))}
        </div>
      )}
    </div>
  )
}
