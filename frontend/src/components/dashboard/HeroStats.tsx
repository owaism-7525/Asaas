import { motion } from 'framer-motion'
import { CalendarClock, Landmark, TrendingUp, Wallet, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { DashCard, DeltaPill, Money, Skel, fmtAmount } from './primitives'

const DAY = 86_400_000

/** Latest change in investments value between the last two daily snapshots. */
export function latestChange(history: { date: string; value: string }[]) {
  const pts = history
    .map((h) => ({ t: new Date(h.date).getTime(), v: parseFloat(h.value) }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v) && p.v > 0)
    .sort((a, b) => a.t - b.t)
  if (pts.length < 2) return null
  const last = pts[pts.length - 1]
  const prev = pts[pts.length - 2]
  const days = Math.round((last.t - prev.t) / DAY)
  return {
    abs: last.v - prev.v,
    pct: ((last.v - prev.v) / prev.v) * 100,
    label: days <= 1 ? 'Day change' : 'Change',
    since: days <= 1
      ? 'vs previous close'
      : `since ${new Date(prev.t).toLocaleDateString('en-PK', { month: 'short', day: 'numeric' })}`,
  }
}

function StatCard({ label, icon: Icon, iconTone = 'jade', children, sub }: {
  label: string
  icon: LucideIcon
  iconTone?: 'jade' | 'gold' | 'info'
  children: React.ReactNode
  sub?: React.ReactNode
}) {
  const tone = {
    jade: 'bg-jade-soft text-jade',
    gold: 'bg-gold-soft text-gold',
    info: 'bg-info-soft text-info',
  }[iconTone]
  return (
    <DashCard className="p-4 flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-faint">{label}</p>
        <span className={cn('w-7 h-7 rounded-md grid place-items-center shrink-0', tone)}>
          <Icon size={14} />
        </span>
      </div>
      <div className="font-display text-[24px] leading-[1.1] font-semibold text-ink">{children}</div>
      {sub && <div className="flex items-center gap-2 flex-wrap min-h-[22px]">{sub}</div>}
    </DashCard>
  )
}

export function HeroStats({
  name, ready, totalWithCash, investments, cash, invested, pnlAbs, pnlPct, history,
}: {
  name?: string
  ready: boolean
  totalWithCash: number | null
  investments: number | null
  cash: number | null
  invested: number | null
  pnlAbs: number | null
  pnlPct: number | null
  history: { date: string; value: string }[]
}) {
  const change = latestChange(history)
  const investShare = totalWithCash && investments != null ? Math.max(0, Math.min(1, investments / totalWithCash)) : null
  const dash = <span className="text-ink-faint">—</span>

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      {/* Hero value */}
      <DashCard className="flex flex-col justify-between gap-5 p-6">
        <div className="flex flex-col gap-1">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">Current value</p>
          {!ready ? <Skel className="h-12 w-60 mt-1" /> : (
            <p className="font-display text-[44px] sm:text-[52px] leading-[1] font-semibold text-ink">
              {totalWithCash != null ? <Money value={totalWithCash} symbolClassName="text-[0.6em] align-[0.35em] mr-0.5 text-ink-soft" /> : '—'}
            </p>
          )}
          <p className="font-sans text-[13px] text-ink-soft mt-1 truncate">{name ?? 'Your portfolio'}</p>
        </div>

        {investShare != null && (
          <div className="flex flex-col gap-2">
            <div className="flex h-2 rounded-full overflow-hidden bg-line-soft" aria-hidden>
              <motion.div
                className="bg-jade"
                initial={{ width: 0 }}
                animate={{ width: `${investShare * 100}%` }}
                transition={{ duration: 0.7, ease: 'easeOut' }}
              />
              <div className="bg-gold flex-1" />
            </div>
            <div className="flex items-center justify-between gap-3 font-mono text-[11px] text-ink-soft">
              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-jade" aria-hidden />
                Investments {Math.round(investShare * 100)}%
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-gold" aria-hidden />
                Cash {100 - Math.round(investShare * 100)}%
              </span>
            </div>
            <p className="font-mono text-[10px] text-ink-faint">
              Valued at today's prices · {new Date().toLocaleDateString('en-PK', { month: 'short', day: 'numeric', year: 'numeric' })}
            </p>
          </div>
        )}
      </DashCard>

      {/* 2×2 stat cards */}
      <div className="grid grid-cols-1 min-[420px]:grid-cols-2 gap-4">
        <StatCard
          label="Total gain / loss"
          icon={TrendingUp}
          sub={pnlPct != null ? <><DeltaPill value={pnlPct * 100} /><span className="font-mono text-[10px] text-ink-faint">all-time</span></> : undefined}
        >
          {!ready ? <Skel className="h-7 w-28" /> : pnlAbs != null
            ? <span className={pnlAbs >= 0 ? 'text-gain' : 'text-loss'}>{pnlAbs >= 0 ? '+' : ''}<Money value={pnlAbs} /></span>
            : dash}
        </StatCard>

        <StatCard
          label="Cash available"
          icon={Wallet}
          iconTone="gold"
          sub={cash != null && totalWithCash
            ? <span className="font-mono text-[11px] text-ink-soft">{Math.round((cash / totalWithCash) * 100)}% of portfolio</span>
            : undefined}
        >
          {cash != null ? <Money value={cash} /> : ready ? dash : <Skel className="h-7 w-28" />}
        </StatCard>

        <StatCard
          label={change?.label ?? 'Day change'}
          icon={CalendarClock}
          iconTone="info"
          sub={change ? <><DeltaPill value={change.pct} /><span className="font-mono text-[10px] text-ink-faint">{change.since}</span></> : undefined}
        >
          {!ready ? <Skel className="h-7 w-28" /> : change
            ? <span className={change.abs >= 0 ? 'text-gain' : 'text-loss'}>{change.abs >= 0 ? '+' : ''}<Money value={change.abs} /></span>
            : dash}
        </StatCard>

        <StatCard
          label="Total invested"
          icon={Landmark}
          sub={investments != null
            ? <span className="font-mono text-[11px] text-ink-soft">now worth ₨{fmtAmount(investments)}</span>
            : undefined}
        >
          {invested != null ? <Money value={invested} /> : ready ? dash : <Skel className="h-7 w-28" />}
        </StatCard>
      </div>
    </div>
  )
}
