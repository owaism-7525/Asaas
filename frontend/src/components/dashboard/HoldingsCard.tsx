import { useNavigate } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { Sparkline } from '@/components/charts/Sparkline'
import { FlagCard } from '@/components/layout/FlagCard'
import { useHoldingHistory, markFlagDismissed } from '@/lib/queries'
import { cn } from '@/lib/utils'
import type { DashboardEvent } from '@/lib/api'
import type { FlagResponse, HoldingResponse, NewsItemResponse, PerformanceResponse } from '@/types/api'
import { AssetChip, DashCard, DeltaPill, Eyebrow, Money, Skel } from './primitives'

const FIXED_INCOME = new Set(['tbill', 'bond'])

type HoldingPerf = NonNullable<PerformanceResponse['holdings_performance']>[number]

function HoldingRow({ h, perf, maturity }: { h: HoldingResponse; perf?: HoldingPerf; maturity?: string }) {
  const navigate = useNavigate()
  const fixed = FIXED_INCOME.has(h.asset_class ?? '')
  // Debt "prices" are stored yields, so a value sparkline would be meaningless.
  const hist = useHoldingHistory(fixed ? undefined : h.symbol)
  const series = (hist.data?.history ?? []).slice(-30).map((p) => parseFloat(p.value)).filter(Number.isFinite)

  const qty = h.quantity ?? (perf?.quantity ? parseFloat(perf.quantity) : undefined)
  const px = perf?.current_price ? parseFloat(perf.current_price) : undefined
  const entry = perf?.entry_price ? parseFloat(perf.entry_price) : h.entry_price
  const value = qty != null && (px ?? entry) != null ? qty * (px ?? entry)! : undefined
  const pnl = perf && !perf.stale ? parseFloat(perf.pnl_pct) : undefined

  return (
    <li>
      <button
        type="button"
        onClick={() => { if (h.symbol) navigate(`/holdings/${h.symbol}`) }}
        className="w-full grid grid-cols-[auto_minmax(0,1fr)_auto] sm:grid-cols-[auto_minmax(0,1fr)_72px_auto] items-center gap-3 px-2 py-2.5 rounded-md text-left hover:bg-jade-soft/50 transition-colors focus-visible:outline-2 focus-visible:outline-jade"
      >
        <AssetChip assetClass={h.asset_class} />
        <div className="min-w-0">
          <p className="font-mono text-[13px] font-semibold text-ink leading-tight truncate">{h.symbol}</p>
          <p className="font-sans text-[11px] text-ink-faint truncate">{h.name}</p>
          <div className="mt-1 flex items-center gap-1.5" aria-label={`Weight ${(h.weight * 100).toFixed(1)}%`}>
            <span className="h-1 w-16 rounded-full bg-line-soft overflow-hidden">
              <span className="block h-full bg-jade/70 rounded-full" style={{ width: `${Math.min(100, h.weight * 100)}%` }} />
            </span>
            <span className="font-mono text-[10px] text-ink-faint tabular-nums">{(h.weight * 100).toFixed(1)}%</span>
          </div>
        </div>
        <div className="hidden sm:flex justify-center">
          {fixed ? (
            <span className="font-mono text-[10px] text-ink-faint text-center leading-tight">
              {maturity ? <>matures<br />{new Date(`${maturity}T00:00:00`).toLocaleDateString('en-PK', { day: 'numeric', month: 'short' })}</> : 'fixed income'}
            </span>
          ) : series.length >= 2 ? (
            <Sparkline data={series} positive={series[series.length - 1] >= series[0]} width={72} height={26} />
          ) : null}
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className="font-mono text-[13px] text-ink tabular-nums">{value != null ? <Money value={value} /> : '—'}</span>
          {pnl != null ? <DeltaPill value={pnl} /> : <span className="font-mono text-[10px] text-ink-faint">—</span>}
        </div>
      </button>
    </li>
  )
}

export function HoldingsCard({ holdings, perf, events }: {
  holdings: HoldingResponse[]
  perf: PerformanceResponse | null
  events: DashboardEvent[]
}) {
  const navigate = useNavigate()
  const sorted = [...holdings].sort((a, b) => b.weight - a.weight)
  const maturityOf = (sym?: string) => events.find((e) => e.type === 'maturity' && e.symbol === sym)?.date

  return (
    <DashCard className="lg:col-span-2 flex flex-col">
      <Eyebrow action={<span className="font-mono text-[10px] text-ink-faint">{holdings.length} positions</span>}>Holdings</Eyebrow>
      <ul className="flex flex-col divide-y divide-line-soft -mx-2">
        {sorted.slice(0, 8).map((h) => (
          <HoldingRow
            key={h.symbol ?? h.instrument_id}
            h={h}
            perf={perf?.holdings_performance?.find((p) => p.symbol === h.symbol)}
            maturity={maturityOf(h.symbol)}
          />
        ))}
      </ul>
      {holdings.length > 8 && (
        <button
          type="button"
          onClick={() => navigate('/portfolio')}
          className="mt-2 self-start font-mono text-[11px] text-jade hover:underline inline-flex items-center gap-1"
        >
          View all {holdings.length} holdings <ChevronRight size={12} aria-hidden />
        </button>
      )}
    </DashCard>
  )
}

/* ─── alerts + material news ─────────────────────────────────────────────── */

const IMPACT: Record<string, { sym: string; cls: string }> = {
  positive: { sym: '▲', cls: 'text-gain bg-jade-soft' },
  negative: { sym: '▼', cls: 'text-loss bg-loss-soft' },
  neutral: { sym: '→', cls: 'text-info bg-info-soft' },
}

export function FeedCard({ flags, flagsReady, news, newsReady }: {
  flags: FlagResponse[]
  flagsReady: boolean
  news: NewsItemResponse[]
  newsReady: boolean
}) {
  const active = flags.filter((f) => !f.dismissed)
  return (
    <DashCard className="flex flex-col">
      <Eyebrow action={
        <a href="/flags" className="font-mono text-[10px] text-jade hover:underline">
          {active.length ? `${active.length} alert${active.length > 1 ? 's' : ''}` : 'Alerts'} →
        </a>
      }>
        Alerts & news
      </Eyebrow>

      {!flagsReady ? <Skel className="h-12 w-full mb-3" /> : active.length === 0 ? (
        <div className="flex items-center gap-2 rounded-md bg-jade-soft px-3 py-2 mb-3">
          <span className="w-2 h-2 rounded-full bg-jade" aria-hidden />
          <p className="font-sans text-[12px] text-ink">All clear — no active alerts</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2 mb-3">
          {active.slice(0, 2).map((f) => <FlagCard key={f.id} flag={f} onDismiss={(id) => markFlagDismissed(id)} />)}
        </div>
      )}

      {!newsReady ? <Skel className="h-28 w-full" /> : (
        <ul className="flex flex-col gap-1">
          {news.slice(0, 4).map((n, i) => {
            const imp = IMPACT[n.impact ?? 'neutral'] ?? IMPACT.neutral
            const mat = n.materiality_score != null && n.materiality_score > 0.7 ? 'Material'
              : n.materiality_score != null && n.materiality_score > 0.4 ? 'Review' : null
            return (
              <li key={n.id ?? i}>
                <a
                  href={n.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex gap-2.5 rounded-md px-2 py-2 -mx-2 hover:bg-paper transition-colors"
                >
                  <span className={cn('mt-0.5 w-5 h-5 rounded-full grid place-items-center shrink-0 font-mono text-[10px]', imp.cls)} aria-label={n.impact ?? 'neutral'}>
                    {imp.sym}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-sans text-[12px] text-ink leading-[1.35] line-clamp-2">{n.headline}</p>
                    <p className="font-mono text-[9px] uppercase tracking-[0.08em] text-ink-faint mt-0.5 flex items-center gap-1.5">
                      <span className="truncate">{n.source?.replace(/_/g, ' ')}</span>
                      <span>· {n.impact_level}</span>
                      {mat && <span className={mat === 'Material' ? 'text-jade font-semibold' : 'text-gold font-semibold'}>· {mat}</span>}
                    </p>
                  </div>
                </a>
              </li>
            )
          })}
          {news.length > 4 && (
            <a href="/news" className="mt-1 font-mono text-[11px] text-jade hover:underline">All news →</a>
          )}
        </ul>
      )}
    </DashCard>
  )
}
