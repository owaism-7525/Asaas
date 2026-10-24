import { useRiskMetrics } from '@/lib/queries'

const pct = (v?: number | null) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`)
const num = (v?: number | null) => (v == null ? '—' : v.toFixed(2))

/**
 * Dashboard "Risk" card — VaR / max drawdown / rolling Sharpe / beta from the
 * backfilled price history (/portfolio/risk). Renders nothing until there's
 * enough overlapping history. Read-only; mirrors MarketSentimentGauge.
 */
export function RiskPanel({ variant = 'list' }: { variant?: 'list' | 'grid' }) {
  const { data } = useRiskMetrics()

  if (!data || data.insufficient_data) return null

  const rows: { label: string; value: string; tone?: 'loss' }[] = [
    { label: 'VaR 95% (1d)', value: pct(data.var_95?.value), tone: 'loss' },
    { label: 'VaR 99% (1d)', value: pct(data.var_99?.value), tone: 'loss' },
    { label: 'CVaR 95%', value: pct(data.cvar_95?.value), tone: 'loss' },
    { label: 'Max drawdown', value: pct(data.max_drawdown?.value), tone: 'loss' },
    { label: 'Volatility (30d)', value: pct(data.rolling_vol_30?.value) },
    { label: 'Sharpe (30d)', value: num(data.rolling_sharpe_30?.value) },
    { label: 'Sortino', value: num(data.sortino?.value) },
    { label: 'Beta (vs PSX)', value: num(data.beta_vs_kse_proxy?.value) },
  ]

  const asOf = data.as_of && (
    <p className="font-mono text-[10px] text-ink-faint">
      {data.observations ?? 0} obs · as of {data.as_of}
    </p>
  )

  // Wide dashboard row: metrics as a dense tile grid.
  if (variant === 'grid') {
    return (
      <div className="bg-card border border-line rounded-lg shadow-sm p-5">
        <div className="flex items-center justify-between gap-2 mb-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">Risk analytics</p>
          {asOf}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {rows.map((r) => (
            <div key={r.label} className="rounded-md bg-paper px-3 py-2.5 flex flex-col gap-1 min-w-0">
              <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-ink-faint truncate">{r.label}</span>
              <span className={`font-mono text-[16px] tabular-nums ${r.tone === 'loss' ? 'text-loss' : 'text-ink'}`}>
                {r.value}
              </span>
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="bg-card border border-line rounded-lg shadow-sm p-5">
      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint mb-3">Risk</p>
      <div className="flex flex-col gap-2">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center justify-between">
            <span className="font-sans text-[12px] text-ink-soft">{r.label}</span>
            <span className={`font-mono text-[13px] tabular-nums ${r.tone === 'loss' ? 'text-loss' : 'text-ink'}`}>
              {r.value}
            </span>
          </div>
        ))}
      </div>
      {asOf && <div className="mt-3">{asOf}</div>}
    </div>
  )
}
