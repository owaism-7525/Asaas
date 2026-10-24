import { useMarketSentiment } from '@/lib/queries'

/** Map a -1…1 score to a label, colour token, and arrow. */
function read(score: number): { label: string; cls: string; arrow: string } {
  if (score >= 0.15) return { label: 'Bullish', cls: 'text-gain', arrow: '▲' }
  if (score <= -0.15) return { label: 'Bearish', cls: 'text-loss', arrow: '▼' }
  return { label: 'Neutral', cls: 'text-ink-soft', arrow: '→' }
}

/**
 * Compact "Market Sentiment" gauge for the dashboard aside. Reads the
 * precomputed /news/sentiment snapshot (Stage 4) — additive signal only, never
 * portfolio math. Renders nothing until data is available.
 */
export function MarketSentimentGauge() {
  const { data } = useMarketSentiment()

  const market = data?.market
  if (!market) return null

  const score = market.score
  const { label, cls, arrow } = read(score)
  // Map -1…1 to 0…100 for the bar fill.
  const pct = Math.round(((score + 1) / 2) * 100)

  return (
    <div className="bg-card border border-line rounded-lg shadow-sm p-5">
      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint mb-3">Market Sentiment</p>
      <div className="flex items-end gap-3 mb-2">
        <span className={`font-display text-[28px] leading-[1] font-semibold tabular-nums ${cls}`}>
          {arrow} {label}
        </span>
        <span className="font-mono text-[11px] text-ink-faint mb-1">{score >= 0 ? '+' : ''}{score.toFixed(2)}</span>
      </div>
      <div className="w-full h-2 bg-line-soft rounded-full overflow-hidden mb-3">
        <div
          className="h-full bg-jade rounded-full transition-all duration-700"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="font-mono text-[11px] text-ink-faint">
        PSX · {market.item_count} items · {market.bullish_count}▲ / {market.bearish_count}▼
        {data?.as_of ? ` · ${data.as_of}` : ''}
      </p>
    </div>
  )
}
