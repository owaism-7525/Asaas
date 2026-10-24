import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { AssetComboBox } from '@/components/ui/combobox'
import { ASSET_UNIVERSE, type AssetCategory } from '@/data/assetUniverse'
import { addHolding, sellHolding, updateHolding, getProfile, putProfile, getQuote } from '@/lib/api'
import { queryClient, qk } from '@/lib/queries'
import { cn } from '@/lib/utils'
import type { HoldingResponse, ProfileResponse } from '@/types/api'

type Panel = 'buy' | 'sell' | 'update' | 'risk' | null

const RISK_TOLERANCES = ['conservative', 'moderately_conservative', 'moderate', 'aggressive', 'very_aggressive'] as const
const HORIZONS = ['short', 'medium', 'long'] as const
const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

const CAT_FILTER: Record<AssetCategory, readonly string[]> = {
  stock: ['equity'],
  bond: ['tbill', 'bond'],
  crypto: ['crypto'],
  commodity: ['commodity'],
}

const CAT_LABEL: Record<AssetCategory, string> = {
  stock: 'Equity', bond: 'Bond / T-Bill', crypto: 'Crypto', commodity: 'Commodity',
}

const inputCls = cn(
  'bg-card border border-line rounded-[6px] px-2 py-2 text-[13px] font-mono tabular-nums text-ink w-full',
  'min-h-[40px] focus-visible:outline-2 focus-visible:outline-jade focus-visible:outline-offset-2',
)
const labelCls = 'font-sans text-[11px] font-medium text-ink mb-1 block'

export function MyActivity({
  holdings,
  onChanged,
}: {
  holdings: HoldingResponse[]
  onChanged: () => void | Promise<void>
}) {
  const [panel, setPanel] = useState<Panel>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // buy
  const [buyCat, setBuyCat] = useState<AssetCategory>('stock')
  const [buySymbol, setBuySymbol] = useState('')
  const [buyQty, setBuyQty] = useState('')
  const [buyPrice, setBuyPrice] = useState('')
  const [buyDate, setBuyDate] = useState('')
  const [quoteState, setQuoteState] = useState<'idle' | 'loading' | 'filled' | 'none'>('idle')
  const quoteSymbolRef = useRef('')

  // Auto-fill the price with the current market quote when a symbol is picked
  // (any asset class — the backend converts USD quotes to PKR). Editable after.
  useEffect(() => {
    const sym = buySymbol.trim()
    quoteSymbolRef.current = sym
    if (!sym) { setQuoteState('idle'); return }
    setQuoteState('loading')
    getQuote(sym)
      .then((q) => {
        if (quoteSymbolRef.current !== sym) return // stale response — symbol changed
        if (q.price_pkr != null) {
          setBuyPrice(parseFloat(q.price_pkr).toFixed(2))
          setQuoteState('filled')
        } else {
          setQuoteState('none')
        }
      })
      .catch(() => { if (quoteSymbolRef.current === sym) setQuoteState('none') })
  }, [buySymbol])
  // sell
  const [sellId, setSellId] = useState('')
  const [sellQty, setSellQty] = useState('')
  const [sellPrice, setSellPrice] = useState('')
  const [sellDate, setSellDate] = useState('')
  // update
  const [updId, setUpdId] = useState('')
  const [updPrice, setUpdPrice] = useState('')
  // risk profile
  const [riskTol, setRiskTol] = useState<string>('moderate')
  const [horizon, setHorizon] = useState<string>('medium')

  // Prefill the risk-profile form from the current profile when its panel opens.
  useEffect(() => {
    if (panel !== 'risk') return
    queryClient.ensureQueryData({ queryKey: qk.profile, queryFn: getProfile })
      .then((p) => { if (p?.risk_tolerance) setRiskTol(p.risk_tolerance); if (p?.horizon) setHorizon(p.horizon) })
      .catch(() => {})
  }, [panel])

  const openPanel = (p: Panel) => { setError(null); setPanel(panel === p ? null : p) }
  const close = () => { setPanel(null); setError(null); setSubmitting(false) }

  async function run(fn: () => Promise<unknown>) {
    setSubmitting(true)
    setError(null)
    try {
      await fn()
      await onChanged()
      close()
    } catch (e) {
      // ApiError.message carries the backend `detail` (e.g. "Insufficient funds: …")
      setError(e instanceof Error && e.message ? e.message : 'Something went wrong.')
      setSubmitting(false)
    }
  }

  const sellable = holdings.filter((h) => h.id && (h.quantity ?? 0) > 0)
  // 2 dp for whole-unit holdings (stocks, debt); keep meaningful digits for
  // fractional crypto/commodity that 2 dp would collapse to "0".
  const fmtQty = (q: number) =>
    Math.abs(q) >= 1
      ? q.toLocaleString('en-PK', { maximumFractionDigits: 2 })
      : q.toLocaleString('en-PK', { maximumFractionDigits: 6 })
  const holdingLabel = (h: HoldingResponse) =>
    `${h.symbol ?? h.name ?? '—'}${h.quantity != null ? ` · ${fmtQty(h.quantity)} units` : ''}`

  const buyValid = !!buySymbol.trim() && parseFloat(buyQty) > 0 && parseFloat(buyPrice) >= 0
  const sellValid = !!sellId && parseFloat(sellQty) > 0 && parseFloat(sellPrice) >= 0
  const updValid = !!updId && parseFloat(updPrice) >= 0

  return (
    <section className="bg-card border border-line rounded-lg shadow-sm p-5 flex flex-col gap-4">
      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">My Activity</p>

      <div className="flex flex-wrap gap-2">
        <Button variant={panel === 'buy' ? 'primary' : 'outline'} size="sm" onClick={() => openPanel('buy')}>I bought</Button>
        <Button variant={panel === 'sell' ? 'primary' : 'outline'} size="sm" onClick={() => openPanel('sell')}>I sold</Button>
        <Button variant={panel === 'update' ? 'primary' : 'outline'} size="sm" onClick={() => openPanel('update')}>Update price</Button>
        <Button variant={panel === 'risk' ? 'primary' : 'outline'} size="sm" onClick={() => openPanel('risk')}>Risk profile</Button>
      </div>

      {/* I bought */}
      {panel === 'buy' && (
        <div className="border border-line rounded-[10px] p-4 flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            {(Object.keys(CAT_FILTER) as AssetCategory[]).map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => { setBuyCat(c); setBuySymbol('') }}
                className={cn(
                  'px-2.5 py-1 rounded-full text-[11px] font-mono border transition-colors',
                  buyCat === c ? 'bg-jade-soft border-jade text-jade' : 'border-line text-ink-soft hover:text-ink',
                )}
              >
                {CAT_LABEL[c]}
              </button>
            ))}
          </div>
          <div>
            <label className={labelCls}>Symbol</label>
            <AssetComboBox
              category={buyCat}
              options={ASSET_UNIVERSE[buyCat]}
              value={buySymbol}
              onChange={setBuySymbol}
              placeholder="Search…"
              assetClass={CAT_FILTER[buyCat]}
            />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div><label className={labelCls}>Quantity</label>
              <input className={inputCls} type="number" inputMode="decimal" placeholder="0" value={buyQty} onChange={(e) => setBuyQty(e.target.value)} /></div>
            <div><label className={labelCls}>Price paid (₨)</label>
              <input className={inputCls} type="number" inputMode="decimal" placeholder={quoteState === 'loading' ? 'Fetching…' : '0.00'} value={buyPrice} onChange={(e) => { setBuyPrice(e.target.value); setQuoteState('idle') }} /></div>
            <div><label className={labelCls}>Date</label>
              <input className={inputCls} type="date" value={buyDate} onChange={(e) => setBuyDate(e.target.value)} /></div>
          </div>
          {quoteState === 'filled' && (
            <p className="font-mono text-[11px] text-ink-faint">
              Auto-filled with the current market price — edit it if you paid a different price.
            </p>
          )}
          {quoteState === 'none' && buySymbol.trim() !== '' && (
            <p className="font-mono text-[11px] text-ink-faint">
              No live market price for {buySymbol.trim()} — enter the price you paid.
            </p>
          )}
          {buyCat === 'stock' && buyQty && Number(buyQty) % 1 !== 0 && (
            <p className="font-mono text-[11px] text-ink-faint">
              Stocks trade in whole shares — this will be recorded as{' '}
              {Math.floor(Number(buyQty))} share{Math.floor(Number(buyQty)) === 1 ? '' : 's'}
              {Math.floor(Number(buyQty)) < 1 ? ' (increase to at least 1).' : '.'}
            </p>
          )}
          <ActivityFooter error={error} submitting={submitting} disabled={!buyValid} onCancel={close} onSubmit={() => {
            const option = ASSET_UNIVERSE[buyCat].find((o) => o.symbol === buySymbol.trim())
            return run(() => addHolding({
              symbol: buySymbol.trim(), quantity: buyQty, entry_price: buyPrice, entry_date: buyDate || undefined,
              asset_class: option?.assetClass, name: option?.name,
            }))
          }} />
        </div>
      )}

      {/* I sold */}
      {panel === 'sell' && (
        <div className="border border-line rounded-[10px] p-4 flex flex-col gap-3">
          {sellable.length === 0 ? (
            <p className="font-sans text-[13px] text-ink-faint">No holdings to sell.</p>
          ) : (
            <>
              <div>
                <label className={labelCls}>Holding</label>
                <select className={inputCls} value={sellId} onChange={(e) => setSellId(e.target.value)}>
                  <option value="">Select a holding…</option>
                  {sellable.map((h) => <option key={h.id} value={h.id}>{holdingLabel(h)}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div><label className={labelCls}>Qty sold</label>
                  <input className={inputCls} type="number" inputMode="decimal" placeholder="0" value={sellQty} onChange={(e) => setSellQty(e.target.value)} /></div>
                <div><label className={labelCls}>Price (₨)</label>
                  <input className={inputCls} type="number" inputMode="decimal" placeholder="0.00" value={sellPrice} onChange={(e) => setSellPrice(e.target.value)} /></div>
                <div><label className={labelCls}>Date</label>
                  <input className={inputCls} type="date" value={sellDate} onChange={(e) => setSellDate(e.target.value)} /></div>
              </div>
              <ActivityFooter error={error} submitting={submitting} disabled={!sellValid} onCancel={close} onSubmit={() =>
                run(() => sellHolding({ holding_id: sellId, quantity: sellQty, price: sellPrice, date: sellDate || undefined }))
              } />
              {sellId && (() => {
                const sel = sellable.find((h) => h.id === sellId)
                return sel ? (
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={() => run(() => sellHolding({
                      holding_id: sellId,
                      quantity: String(sel.quantity ?? 0),
                      price: sellPrice || String(sel.current_price ?? sel.entry_price ?? 0),
                      date: sellDate || undefined,
                    }))}
                    className="self-start font-mono text-[12px] text-loss hover:underline disabled:opacity-50"
                  >
                    Liquidate entire holding ({fmtQty(sel.quantity ?? 0)} units)
                  </button>
                ) : null
              })()}
            </>
          )}
        </div>
      )}

      {/* Risk profile (quick inline edit) */}
      {panel === 'risk' && (
        <div className="border border-line rounded-[10px] p-4 flex flex-col gap-3">
          <p className="font-sans text-[13px] text-ink-soft">
            Update your risk profile — used by the optimiser and suggestions.
          </p>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={labelCls}>Risk tolerance</label>
              <select className={inputCls} value={riskTol} onChange={(e) => setRiskTol(e.target.value)}>
                {RISK_TOLERANCES.map((r) => <option key={r} value={r}>{titleCase(r)}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls}>Horizon</label>
              <select className={inputCls} value={horizon} onChange={(e) => setHorizon(e.target.value)}>
                {HORIZONS.map((h) => <option key={h} value={h}>{titleCase(h)}</option>)}
              </select>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              const message =
                `Explain my risk profile: I have a ${riskTol} risk tolerance and a ${horizon} ` +
                `investment horizon. What does that mean for how my portfolio should be built, ` +
                `and is my current allocation aligned with it?`
              window.dispatchEvent(new CustomEvent('raabta:ask', { detail: { message } }))
            }}
            className="self-start font-mono text-[11px] px-2.5 py-1 rounded-full bg-jade text-white hover:bg-jade-dark transition-colors btn-press"
          >
            💬 Ask Raabta AI
          </button>
          <ActivityFooter error={error} submitting={submitting} disabled={false} onCancel={close} onSubmit={() =>
            run(async () => {
              const p = await putProfile({
                risk_tolerance: riskTol as ProfileResponse['risk_tolerance'],
                horizon: horizon as ProfileResponse['horizon'],
              })
              queryClient.setQueryData(qk.profile, p)
            })
          } />
        </div>
      )}

      {/* Update price */}
      {panel === 'update' && (
        <div className="border border-line rounded-[10px] p-4 flex flex-col gap-3">
          {holdings.length === 0 ? (
            <p className="font-sans text-[13px] text-ink-faint">No holdings to update.</p>
          ) : (
            <>
              <div>
                <label className={labelCls}>Holding</label>
                <select className={inputCls} value={updId} onChange={(e) => setUpdId(e.target.value)}>
                  <option value="">Select a holding…</option>
                  {holdings.filter((h) => h.id).map((h) => <option key={h.id} value={h.id}>{holdingLabel(h)}</option>)}
                </select>
              </div>
              <div>
                <label className={labelCls}>New entry price (₨)</label>
                <input className={inputCls} type="number" inputMode="decimal" placeholder="0.00" value={updPrice} onChange={(e) => setUpdPrice(e.target.value)} />
              </div>
              <ActivityFooter error={error} submitting={submitting} disabled={!updValid} onCancel={close} onSubmit={() =>
                run(() => updateHolding(updId, { entry_price: updPrice }))
              } />
            </>
          )}
        </div>
      )}
    </section>
  )
}

function ActivityFooter({
  error, submitting, disabled, onCancel, onSubmit,
}: {
  error: string | null; submitting: boolean; disabled: boolean; onCancel: () => void; onSubmit: () => void
}) {
  return (
    <>
      {error && <p className="font-sans text-[12px] text-loss" role="alert">{error}</p>}
      <div className="flex gap-2 justify-end">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={submitting}>Cancel</Button>
        <Button variant="primary" size="sm" onClick={onSubmit} disabled={disabled || submitting}>
          {submitting ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </>
  )
}
