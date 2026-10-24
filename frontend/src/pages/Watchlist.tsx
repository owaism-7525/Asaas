import { useState } from 'react'
import { addToWatchlist, removeFromWatchlist } from '@/lib/api'
import { queryClient, qk, useWatchlist } from '@/lib/queries'
import { Button } from '@/components/ui/button'
import { AssetComboBox } from '@/components/ui/combobox'
import { ASSET_UNIVERSE, type AssetCategory } from '@/data/assetUniverse'
import { cn } from '@/lib/utils'
import type { WatchlistItem, WatchlistResponse } from '@/types/api'

// Instrument asset_class → display group
type Group = 'stock' | 'commodity' | 'debt' | 'crypto'

const GROUP_OF: Record<string, Group> = {
  psx_stock: 'stock',
  global_stock: 'stock',
  mutual_fund: 'stock',
  commodity: 'commodity',
  tbill: 'debt',
  bond: 'debt',
  crypto: 'crypto',
}

const GROUP_META: Record<Group, { label: string; dot: string }> = {
  stock:     { label: 'Stocks',      dot: 'bg-jade' },
  commodity: { label: 'Commodities', dot: 'bg-gold' },
  debt:      { label: 'Debt',        dot: 'bg-info' },
  crypto:    { label: 'Crypto',      dot: 'bg-plum' },
}

const GROUP_ORDER: Group[] = ['stock', 'commodity', 'debt', 'crypto']

// Add-form category chips reuse the picker universe categories
const CAT_FILTER: Record<AssetCategory, readonly string[]> = {
  stock: ['equity'],
  bond: ['tbill', 'bond'],
  crypto: ['crypto'],
  commodity: ['commodity'],
}

const CAT_LABEL: Record<AssetCategory, string> = {
  stock: 'Stocks', bond: 'Debt', crypto: 'Crypto', commodity: 'Commodities',
}

function fmtPrice(item: WatchlistItem): string {
  if (item.price == null) return '—'
  const n = parseFloat(item.price)
  if (isNaN(n)) return '—'
  const formatted = n.toLocaleString('en-PK', { maximumFractionDigits: 2 })
  return item.currency === 'PKR' ? `₨${formatted}` : `$${formatted}`
}

export default function Watchlist() {
  const watchlistQ = useWatchlist()
  const items: WatchlistItem[] = watchlistQ.data?.items ?? []
  const loading = watchlistQ.status === 'pending'
  const [cat, setCat] = useState<AssetCategory>('stock')
  const [symbol, setSymbol] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function add() {
    if (!symbol.trim()) return
    setAdding(true)
    setError(null)
    try {
      // Send the picker's asset class + name so unseeded symbols (crypto,
      // commodities, bonds) get registered on demand instead of 404ing.
      const option = ASSET_UNIVERSE[cat].find((o) => o.symbol === symbol.trim())
      await addToWatchlist(symbol.trim(), option?.assetClass, option?.name)
      setSymbol('')
      await queryClient.invalidateQueries({ queryKey: qk.watchlist }) // re-fetch so the new row carries a price
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Could not add to watchlist.')
    } finally {
      setAdding(false)
    }
  }

  async function remove(id: string) {
    queryClient.setQueryData<WatchlistResponse>(qk.watchlist, (prev) =>
      prev && { ...prev, items: prev.items.filter((i) => i.id !== id) }) // optimistic
    try {
      await removeFromWatchlist(id)
    } catch {
      await queryClient.invalidateQueries({ queryKey: qk.watchlist })
    }
  }

  const grouped = GROUP_ORDER
    .map((g) => ({
      group: g,
      rows: items.filter((i) => (GROUP_OF[i.asset_class] ?? 'stock') === g),
    }))
    .filter(({ rows }) => rows.length > 0)

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div>
        <h1 className="font-display text-[28px] font-semibold text-ink">Watchlist</h1>
        <p className="font-sans text-[14px] text-ink-soft mt-1">
          Stocks, commodities, debt and crypto you're keeping an eye on.
        </p>
      </div>

      {/* Add form */}
      <section className="bg-card border border-line rounded-[12px] p-5 flex flex-col gap-3">
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">Add to watchlist</p>
        <div className="flex flex-wrap gap-2">
          {(Object.keys(CAT_FILTER) as AssetCategory[]).map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => { setCat(c); setSymbol('') }}
              className={cn(
                'px-2.5 py-1 rounded-full text-[11px] font-mono border transition-colors',
                cat === c ? 'bg-jade-soft border-jade text-jade' : 'border-line text-ink-soft hover:text-ink',
              )}
            >
              {CAT_LABEL[c]}
            </button>
          ))}
        </div>
        <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
          <div className="flex-1">
            <AssetComboBox
              category={cat}
              options={ASSET_UNIVERSE[cat]}
              value={symbol}
              onChange={(s) => { setSymbol(s); setError(null) }}
              placeholder="Search…"
              assetClass={CAT_FILTER[cat]}
            />
          </div>
          <Button variant="primary" size="sm" onClick={add} disabled={!symbol.trim() || adding}>
            {adding ? 'Adding…' : 'Add'}
          </Button>
        </div>
        {error && <p className="font-sans text-[12px] text-loss" role="alert">{error}</p>}
      </section>

      {/* Watched instruments, grouped by asset class */}
      {loading ? (
        <div className="bg-card border border-line rounded-[12px] p-8 text-center">
          <span className="w-3 h-3 inline-block rounded-full bg-jade animate-dot-pulse" aria-label="Loading…" />
        </div>
      ) : items.length === 0 ? (
        <div className="bg-card border border-line rounded-[12px] p-8 text-center">
          <p className="font-sans text-[14px] text-ink-soft">Your watchlist is empty.</p>
          <p className="font-sans text-[12px] text-ink-faint mt-1">
            Add a stock, commodity, T-bill or crypto above to start tracking it.
          </p>
        </div>
      ) : (
        grouped.map(({ group, rows }) => (
          <section key={group} className="bg-card border border-line rounded-[12px] overflow-hidden">
            <div className="flex items-center gap-2 px-4 pt-4 pb-2">
              <span className={cn('w-2 h-2 rounded-full', GROUP_META[group].dot)} />
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">
                {GROUP_META[group].label}
              </p>
              <span className="font-mono text-[10px] text-ink-faint ml-auto">{rows.length}</span>
            </div>
            <table className="w-full">
              <thead>
                <tr className="border-b border-line-soft">
                  <th className="px-4 py-2 text-left font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint font-normal">Symbol</th>
                  <th className="px-4 py-2 text-left font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint font-normal hidden sm:table-cell">Sector</th>
                  <th className="px-4 py-2 text-right font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint font-normal">Price</th>
                  <th className="px-2 py-2 w-10" />
                </tr>
              </thead>
              <tbody>
                {rows.map((item) => (
                  <tr key={item.id} className="border-b border-line-soft last:border-0 hover:bg-line-soft/30 transition-colors">
                    <td className="px-4 py-3">
                      <p className="font-mono text-[13px] text-ink">{item.symbol}</p>
                      <p className="font-sans text-[12px] text-ink-faint truncate max-w-[220px]">{item.name}</p>
                    </td>
                    <td className="px-4 py-3 font-sans text-[12px] text-ink-soft hidden sm:table-cell">
                      {item.sector ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-[13px] tabular-nums text-ink">
                      {fmtPrice(item)}
                    </td>
                    <td className="px-2 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => remove(item.id)}
                        aria-label={`Remove ${item.symbol} from watchlist`}
                        className="font-mono text-[13px] text-ink-faint hover:text-loss px-2 py-1 rounded focus-visible:outline-2 focus-visible:outline-jade"
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))
      )}
    </div>
  )
}
