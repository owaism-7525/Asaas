import { useMemo, useRef } from 'react'
import { type TickerItem, type TickerResponse } from '@/lib/api'
import { useTicker } from '@/lib/queries'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PriceDisplayItem {
  type: 'price'
  label: string
  value: string
  changePct: number | null
  positive: boolean | null
}

interface NewsDisplayItem {
  type: 'news'
  source: string
  headline: string
}

type DisplayItem = PriceDisplayItem | NewsDisplayItem

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatPrice(item: TickerItem): string {
  const val = parseFloat(item.price)
  if (isNaN(val)) return item.price
  if (item.currency === '%') return `${val.toFixed(2)}%`
  if (item.currency === 'PKR') {
    if (val >= 1_000_000) return `₨${(val / 1_000_000).toFixed(2)}M`
    if (val >= 1_000) return `₨${val.toLocaleString('en-PK', { maximumFractionDigits: 0 })}`
    return `₨${val.toFixed(2)}`
  }
  if (item.currency === 'USD') {
    if (val >= 1_000) return `$${val.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
    return `$${val.toFixed(2)}`
  }
  return val.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

function priceItem(label: string, item: TickerItem): PriceDisplayItem {
  return {
    type: 'price',
    label,
    value: formatPrice(item),
    changePct: item.change_pct,
    positive: item.change_pct != null ? item.change_pct >= 0 : null,
  }
}

function formatAsOf(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit', hour12: false })
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// Build ordered display list — spec order, news interleaved
// ---------------------------------------------------------------------------

const STOCK_ORDER = ['HBL', 'OGDC', 'PPL', 'LUCK', 'ENGRO', 'MCB', 'UBL', 'FFC']
const CRYPTO_ORDER = ['BTC', 'ETH', 'SOL', 'XRP', 'ADA']
const COMMODITY_MAP: Record<string, string> = {
  'GC=F': 'Gold', 'SI=F': 'Silver', 'CL=F': 'WTI', 'CT=F': 'Cotton',
}
const RATE_ORDER: Array<[string, string]> = [
  ['MTB-3M', '3M T-Bill'], ['MTB-6M', '6M T-Bill'], ['MTB-12M', '12M T-Bill'], ['SBP', 'SBP Rate'],
]

function buildDisplayItems(items: TickerItem[]): DisplayItem[] {
  const priceItems: PriceDisplayItem[] = []

  // KSE-100 first
  const kse = items.find(t => t.symbol === 'KSE-100')
  if (kse) priceItems.push(priceItem('KSE-100', kse))

  // PSX stocks in spec order
  for (const sym of STOCK_ORDER) {
    const s = items.find(t => t.symbol === `${sym}.KA`)
    if (s) priceItems.push(priceItem(sym, s))
  }

  // Crypto
  for (const sym of CRYPTO_ORDER) {
    const c = items.find(t => t.symbol === sym)
    if (c) priceItems.push(priceItem(sym, c))
  }

  // Commodities in spec order
  for (const [sym, label] of Object.entries(COMMODITY_MAP)) {
    const c = items.find(t => t.symbol === sym)
    if (c) priceItems.push(priceItem(label, c))
  }

  // T-bill/rate yields
  for (const [sym, label] of RATE_ORDER) {
    const r = items.find(t => t.symbol === sym)
    if (r) priceItems.push(priceItem(label, r))
  }

  // USD/PKR
  const fx = items.find(t => t.asset_class === 'fx')
  if (fx) priceItems.push(priceItem('USD/PKR', fx))

  // News headlines — interleave evenly through the price list
  const newsRaw = items.filter(t => t.asset_class === 'news')
  const newsItems: NewsDisplayItem[] = newsRaw.map(n => ({
    type: 'news',
    source: n.source.replace('_', ' ').toUpperCase(),
    headline: n.name,
  }))

  if (newsItems.length === 0) return priceItems

  const interval = Math.max(1, Math.floor(priceItems.length / (newsItems.length + 1)))
  const result: DisplayItem[] = []
  let ni = 0
  for (let i = 0; i < priceItems.length; i++) {
    result.push(priceItems[i])
    if (ni < newsItems.length && (i + 1) % interval === 0) {
      result.push(newsItems[ni++])
    }
  }
  // Append any remaining news at the end
  while (ni < newsItems.length) result.push(newsItems[ni++])

  return result
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function PriceChip({ item }: { item: PriceDisplayItem }) {
  return (
    <span className="flex items-baseline gap-1 shrink-0 px-3" aria-label={`${item.label} ${item.value}`}>
      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint font-medium leading-none">
        {item.label}
      </span>
      <span className="font-mono text-[11px] tabular-nums text-ink font-semibold leading-none">
        {item.value}
      </span>
      {item.changePct !== null && (
        <span
          className={cn(
            'font-mono text-[10px] tabular-nums leading-none',
            item.positive === true ? 'text-gain' : item.positive === false ? 'text-loss' : 'text-ink-faint',
          )}
          aria-label={`${item.positive ? 'up' : 'down'} ${Math.abs(item.changePct).toFixed(2)} percent`}
        >
          {item.positive === true ? '▲' : item.positive === false ? '▼' : ''}
          {item.changePct >= 0 ? '+' : ''}{item.changePct.toFixed(2)}%
        </span>
      )}
      <span className="w-px h-3 bg-line mx-1 shrink-0 self-center" aria-hidden />
    </span>
  )
}

function NewsChip({ item }: { item: NewsDisplayItem }) {
  return (
    <span className="flex items-baseline gap-1.5 shrink-0 px-3" aria-label={`News: ${item.headline}`}>
      <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint/70 leading-none">
        {item.source}
      </span>
      <span className="font-mono text-[10px] text-ink-soft leading-none max-w-[28ch] truncate italic">
        {item.headline}
      </span>
      <span className="w-px h-3 bg-line mx-1 shrink-0 self-center" aria-hidden />
    </span>
  )
}

function Skeleton() {
  return (
    <div className="h-7 bg-card border-b border-line flex items-center overflow-hidden">
      <div className="flex items-center gap-6 px-4">
        {[16, 20, 14, 18, 16, 20].map((w, i) => (
          <div
            key={i}
            className="h-2.5 rounded"
            style={{
              width: `${w * 4}px`,
              background: 'linear-gradient(90deg, rgb(var(--line)) 25%, rgb(var(--line-soft)) 50%, rgb(var(--line)) 75%)',
              backgroundSize: '400% 100%',
              animation: 'skeleton-shimmer 1.5s ease-in-out infinite',
            }}
          />
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function MarketTicker() {
  const tickerQ = useTicker()
  const response: TickerResponse | null = tickerQ.data ?? null
  const loading = tickerQ.status === 'pending'
  const reduced = useReducedMotion()
  const containerRef = useRef<HTMLDivElement>(null)

  const displayItems = useMemo(
    () => (response ? buildDisplayItems(response.items) : []),
    [response],
  )

  if (loading) return <Skeleton />
  if (displayItems.length === 0) return null

  // ~40 s for a full loop; scale gently with item count so very long sets stay readable
  const durationS = Math.max(40, displayItems.length * 2)

  // Duplicate set for seamless infinite loop
  const doubled = [...displayItems, ...displayItems]

  return (
    <div
      className="ticker-band h-7 bg-card border-b border-line overflow-hidden relative select-none"
      role="region"
      aria-label="Live market ticker"
      aria-live="off"
    >
      {/* Left fade edge — theme-aware card colour */}
      <div
        className="absolute left-0 top-0 bottom-0 w-10 z-10 pointer-events-none"
        style={{ background: 'linear-gradient(to right, rgb(var(--card)) 30%, transparent)' }}
        aria-hidden
      />

      {/* Stale indicator — always show when data exists, prominent when stale.
       * Sits on an opaque card-coloured pill with a wide left fade so the
       * scrolling ticker text disappears cleanly instead of overlapping it. */}
      {response?.as_of && (
        <div className="absolute right-0 top-0 bottom-0 z-20 flex items-center pointer-events-none">
          <div
            className="w-14 h-full"
            style={{ background: 'linear-gradient(to right, transparent, rgb(var(--card)) 70%)' }}
            aria-hidden
          />
          <span
            className={cn(
              'bg-card pr-3 pl-1 h-full flex items-center font-mono text-[9px] tracking-wide whitespace-nowrap',
              response.stale ? 'text-loss/70' : 'text-ink-faint/60',
            )}
            aria-label={`Market data as of ${formatAsOf(response.as_of)}`}
          >
            as of {formatAsOf(response.as_of)}
          </span>
        </div>
      )}

      {reduced ? (
        // Reduced motion: static scrollable row
        <div className="flex items-center h-full overflow-x-auto scrollbar-none" ref={containerRef}>
          {displayItems.map((item, i) =>
            item.type === 'news'
              ? <NewsChip key={`n-${i}`} item={item} />
              : <PriceChip key={`p-${i}`} item={item} />
          )}
        </div>
      ) : (
        // Normal: pure CSS translateX scroll, pause on hover
        <div
          ref={containerRef}
          className="ticker-track flex items-center h-full"
          style={{
            animation: `ticker-scroll ${durationS}s linear infinite`,
            willChange: 'transform',
          }}
        >
          {doubled.map((item, i) =>
            item.type === 'news'
              ? <NewsChip key={`n-${i}`} item={item} />
              : <PriceChip key={`p-${i}`} item={item} />
          )}
        </div>
      )}

      <style>{`
        @keyframes ticker-scroll {
          from { transform: translateX(0); }
          to   { transform: translateX(-50%); }
        }
        @keyframes skeleton-shimmer {
          0%   { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        /* Pause scroll on hover — pure CSS, no JS per frame */
        .ticker-band:hover .ticker-track {
          animation-play-state: paused;
        }
        /* Hide scrollbar for reduced-motion static row */
        .scrollbar-none { scrollbar-width: none; }
        .scrollbar-none::-webkit-scrollbar { display: none; }
        /* Respect reduced-motion */
        @media (prefers-reduced-motion: reduce) {
          .ticker-track { animation: none !important; }
        }
      `}</style>
    </div>
  )
}
