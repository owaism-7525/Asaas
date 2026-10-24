import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { getCompanyInfo, postValuation, getTechnical, getNewsFeed, getDebtInstrument, getPortfolio, getHoldingHistory } from '@/lib/api'
import { queryClient, qk } from '@/lib/queries'
import { getCapabilities } from '@/lib/capabilities'
import { ValuationCard } from '@/components/chat/cards/ValuationCard'
import { TechnicalCard } from '@/components/chat/cards/TechnicalCard'
import { PerformanceLine } from '@/components/charts/PerformanceLine'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { ValuationResponse, TechnicalResponse, NewsItemResponse, DebtInstrument, HoldingResponse } from '@/types/api'

type Tab = 'overview' | 'valuation' | 'technical' | 'news'
type HoldRange = '1w' | '1m' | '6m' | '1y'

const TAB_LABELS: Record<Tab, string> = {
  overview: 'Overview',
  valuation: 'Valuation',
  technical: 'Technical',
  news: 'News',
}

const IMPACT_SYMBOL: Record<string, string> = {
  positive: '↑',
  negative: '↓',
  neutral: '→',
}

/** Best-effort asset-class inference from a ticker, mirroring the DB symbol scheme. */
function inferAssetClass(sym: string): string | undefined {
  const s = sym.toUpperCase()
  if (s.endsWith('.KA')) return 'equity'
  if (s.endsWith('=F')) return 'commodity'
  if (/^(BTC|ETH|SOL|BNB|XRP|ADA|DOGE)$/.test(s)) return 'crypto'
  if (/^(MTB|PIB|GIS|TBILL|PKGB)/.test(s)) return 'tbill'
  return undefined
}

/** Market cap → abbreviated PKR to 2 decimals (₨1.23T / ₨45.60B / ₨9.80M). */
function fmtMarketCap(v?: string | null): string {
  if (v == null || v === '') return '—'
  const n = parseFloat(v)
  if (!isFinite(n)) return '—'
  const abs = Math.abs(n)
  if (abs >= 1e12) return `₨${(n / 1e12).toFixed(2)}T`
  if (abs >= 1e9) return `₨${(n / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `₨${(n / 1e6).toFixed(2)}M`
  return `₨${n.toLocaleString('en-PK', { maximumFractionDigits: 2 })}`
}

/** Beta → 2 decimals (or em dash when absent/non-numeric). */
function fmtBeta(v?: string | null): string {
  if (v == null || v === '') return '—'
  const n = parseFloat(v)
  return isFinite(n) ? n.toFixed(2) : '—'
}

export default function HoldingDetail() {
  const { symbol: rawSymbol } = useParams<{ symbol: string }>()
  // Reject empty params AND the literal "null"/"undefined" strings that result
  // from navigating to /holdings/<undefined>, which would fire /analysis/.../null.
  const symbol =
    rawSymbol && rawSymbol !== 'null' && rawSymbol !== 'undefined' ? rawSymbol : undefined

  const assetClass = symbol ? inferAssetClass(symbol) : undefined
  const isFixedIncome = assetClass === 'tbill' || assetClass === 'bond'

  // Class-aware visibility: only render tabs whose method applies to this asset
  // class (no Technical on a bond, no Valuation tab if no method is supported).
  const caps = getCapabilities(assetClass)
  const tabs: Tab[] = [
    'overview',
    ...(caps.valuationMethods.length > 0 ? (['valuation'] as Tab[]) : []),
    ...(caps.technical.enabled ? (['technical'] as Tab[]) : []),
    'news',
  ]

  const [tab, setTab] = useState<Tab>('overview')

  // If the selected tab isn't available for this asset class (e.g. navigating
  // from a stock's Technical tab to a T-bill), fall back to Overview.
  useEffect(() => {
    if (!tabs.includes(tab)) setTab('overview')
  }, [tabs, tab])
  const [company, setCompany] = useState<ValuationResponse['company_info'] | null>(null)
  const [companyLoading, setCompanyLoading] = useState(true)

  // Live PSX debt-instrument data + the user's holding (for T-bills / bonds)
  const [debt, setDebt] = useState<DebtInstrument | null>(null)
  const [debtSettled, setDebtSettled] = useState(false)
  const [holding, setHolding] = useState<HoldingResponse | null>(null)

  // Lazy-loaded per tab
  const [valuation, setValuation] = useState<ValuationResponse | null>(null)
  const [valuationLoading, setValuationLoading] = useState(false)
  const [valuationError, setValuationError] = useState<string | null>(null)

  const [technical, setTechnical] = useState<TechnicalResponse | null>(null)
  const [technicalLoading, setTechnicalLoading] = useState(false)
  const [technicalError, setTechnicalError] = useState<string | null>(null)

  const [newsItems, setNewsItems] = useState<NewsItemResponse[]>([])
  const [newsLoading, setNewsLoading] = useState(false)

  // Per-holding value history (its own performance graph, like the dashboard's).
  const [holdHistory, setHoldHistory] = useState<{ date: string; value: string }[]>([])
  const [holdRange, setHoldRange] = useState<HoldRange>('1m')

  // Reset all per-symbol lazy state when navigating between holdings — otherwise
  // the fetch-guards below (!valuation, !technical, newsItems.length===0) see
  // stale data from the previous symbol and skip refetching.
  useEffect(() => {
    setCompany(null)
    setCompanyLoading(true)
    setDebt(null)
    setHolding(null)
    setValuation(null)
    setValuationLoading(false)
    setValuationError(null)
    setTechnical(null)
    setTechnicalLoading(false)
    setTechnicalError(null)
    setNewsItems([])
    setNewsLoading(false)
    setHoldHistory([])
  }, [symbol])

  // Per-holding value history for its performance graph (skip fixed income).
  useEffect(() => {
    if (!symbol || isFixedIncome) return
    getHoldingHistory(symbol)
      .then((r) => setHoldHistory(r.history ?? []))
      .catch(() => setHoldHistory([]))
  }, [symbol, isFixedIncome])

  useEffect(() => {
    if (!symbol) return
    getCompanyInfo(symbol)
      .then(setCompany)
      .catch(() => {})
      .finally(() => setCompanyLoading(false))
  }, [symbol])

  // For T-bills / bonds, pull live PSX instrument terms + the user's holding so
  // the valuation call can compute a real, personalised yield-to-maturity.
  useEffect(() => {
    if (!symbol || !isFixedIncome) {
      setDebtSettled(true)
      return
    }
    setDebtSettled(false)
    getDebtInstrument(symbol).then(setDebt).catch(() => setDebt(null)).finally(() => setDebtSettled(true))
    queryClient.ensureQueryData({ queryKey: qk.portfolio, queryFn: getPortfolio })
      .then((p) => setHolding(p.holdings.find((h) => h.symbol === symbol) ?? null))
      .catch(() => setHolding(null))
  }, [symbol, isFixedIncome])

  useEffect(() => {
    if (!symbol) return
    // For fixed income, wait until the live debt fetch has settled so we can
    // forward face_value / coupon_rate / buy_date and get a real YTM.
    if (tab === 'valuation' && !valuation && !valuationLoading && (!isFixedIncome || debtSettled)) {
      setValuationLoading(true)
      const opts: Parameters<typeof postValuation>[1] = { asset_class: assetClass }
      if (isFixedIncome) {
        if (debt?.face_value != null) opts.face_value = debt.face_value
        if (debt?.coupon_rate != null) opts.coupon_rate = debt.coupon_rate * 100 // fraction → percent
        if (holding?.entry_date) opts.buy_date = holding.entry_date
      }
      postValuation(symbol, opts)
        .then(setValuation)
        .catch((e) => setValuationError(e instanceof Error ? e.message : 'Failed to load valuation.'))
        .finally(() => setValuationLoading(false))
    }
    if (tab === 'technical' && !technical && !technicalLoading) {
      setTechnicalLoading(true)
      getTechnical(symbol, assetClass)
        .then(setTechnical)
        .catch((e) => setTechnicalError(e instanceof Error ? e.message : 'Failed to load technical data.'))
        .finally(() => setTechnicalLoading(false))
    }
    if (tab === 'news' && newsItems.length === 0 && !newsLoading) {
      setNewsLoading(true)
      queryClient.ensureQueryData({ queryKey: qk.news, queryFn: getNewsFeed })
        .then((all) => setNewsItems(all.filter((n) => n.affected_symbols?.includes(symbol ?? ''))))
        .catch(() => {})
        .finally(() => setNewsLoading(false))
    }
  }, [tab, symbol, debtSettled, isFixedIncome])

  // Window the holding history to the selected range (falls back to full series).
  const holdVisible = useMemo(() => {
    if (holdHistory.length === 0) return holdHistory
    const days: Record<HoldRange, number> = { '1w': 7, '1m': 30, '6m': 180, '1y': 365 }
    const cutoff = Date.now() - days[holdRange] * 86_400_000
    const windowed = holdHistory.filter((h) => new Date(h.date).getTime() >= cutoff)
    return windowed.length >= 2 ? windowed : holdHistory
  }, [holdHistory, holdRange])

  if (!symbol) return null

  // Hand the current analysis to Raabta AI for a plain-language explanation —
  // mirrors the News page's "Affect on my portfolio?" (dispatches raabta:ask).
  const askRaabta = (topic: 'valuation' | 'technical') => {
    const name = company?.name || symbol
    const message =
      topic === 'valuation'
        ? `Explain the valuation of ${name} (${symbol}) in simple terms — what do the ` +
          `numbers mean (fair value, P/E, DCF or yield-to-maturity), and does it look ` +
          `over- or under-valued? Also tell me whether I hold it and its role in my portfolio.`
        : `Explain the technical analysis of ${name} (${symbol}) in simple terms — what do ` +
          `the indicators (RSI, MACD, moving averages and any crossover signals) suggest, ` +
          `and what should I watch? Also tell me whether I hold it.`
    window.dispatchEvent(new CustomEvent('raabta:ask', { detail: { message } }))
  }

  const askButtonClass =
    'mt-4 font-mono text-[12px] px-3 py-1.5 rounded-full bg-jade text-white hover:bg-jade-dark transition-colors btn-press'

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          {companyLoading ? (
            <div className="h-8 w-40 bg-line animate-pulse rounded" />
          ) : (
            <h1 className="font-display text-[28px] font-semibold text-ink leading-[1.1]">
              {company?.name ?? symbol}
            </h1>
          )}
          <div className="flex items-center gap-2 mt-1">
            <Badge variant="neutral">
              <span className="font-mono">{symbol}</span>
            </Badge>
            {company?.sector && (
              <Badge variant="info">{company.sector}</Badge>
            )}
          </div>
        </div>
        {company?.current_price && (
          <div className="text-right">
            <p className="font-mono text-[24px] font-semibold text-ink tabular-nums">
              ₨{parseFloat(company.current_price).toLocaleString('en-PK')}
            </p>
          </div>
        )}
      </div>

      {/* Class-level warning (e.g. crypto regulatory status) */}
      {caps.warnings.map((w) => (
        <div
          key={w}
          role="note"
          className="bg-gold-soft border border-gold/40 rounded-[8px] px-4 py-3 font-sans text-[13px] text-ink-soft leading-[1.5]"
        >
          {w}
        </div>
      ))}

      {/* Tabs */}
      <div className="flex gap-0 border-b border-line" role="tablist">
        {tabs.map((value) => (
          <button
            key={value}
            role="tab"
            type="button"
            onClick={() => setTab(value)}
            aria-selected={tab === value}
            className={cn(
              'px-4 py-2.5 font-mono text-[12px] uppercase tracking-[0.12em] border-b-2 transition-colors -mb-px min-h-[44px]',
              'focus-visible:outline-2 focus-visible:outline-jade focus-visible:outline-offset-2',
              tab === value
                ? 'border-jade text-jade'
                : 'border-transparent text-ink-soft hover:text-ink',
            )}
          >
            {TAB_LABELS[value]}
          </button>
        ))}
      </div>

      {/* Tab panels */}
      {tab === 'overview' && (
        <div className="flex flex-col gap-4">
          {/* Per-holding performance graph (skips fixed income) */}
          {!isFixedIncome && holdVisible.length > 1 && (
            <div className="bg-card border border-line rounded-[10px] p-4 flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-faint">Performance</span>
                <div className="flex gap-1">
                  {(['1w', '1m', '6m', '1y'] as HoldRange[]).map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setHoldRange(r)}
                      className={cn(
                        'px-2 py-0.5 rounded-[6px] font-mono text-[11px] uppercase transition-colors',
                        holdRange === r ? 'bg-jade text-white' : 'text-ink-faint hover:text-ink hover:bg-line-soft',
                      )}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </div>
              <PerformanceLine history={holdVisible} height={200} lineColor="#0F6E56" />
            </div>
          )}
          {isFixedIncome ? (
            debt ? (
              <>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  {[
                    { label: 'Coupon / YTM', value: debt.coupon_rate != null ? `${(debt.coupon_rate * 100).toFixed(2)}%` : '—' },
                    { label: 'Face value', value: debt.face_value != null ? `₨${debt.face_value.toLocaleString('en-PK')}` : '—' },
                    { label: 'Maturity', value: debt.maturity_date || '—' },
                    { label: 'Remaining', value: debt.remaining_years != null ? `${debt.remaining_years} yr` : '—' },
                  ].map(({ label, value }) => (
                    <div key={label} className="bg-card border border-line rounded-[8px] p-4 flex flex-col gap-1">
                      <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-faint">{label}</span>
                      <span className="font-mono text-[15px] font-medium text-ink tabular-nums">{String(value)}</span>
                    </div>
                  ))}
                </div>
                <p className="font-mono text-[10px] text-ink-faint">Data: PSX Debt Market</p>
              </>
            ) : !debtSettled ? (
              <div className="h-24 bg-line animate-pulse rounded-[8px]" />
            ) : (
              <p className="font-sans text-[14px] text-ink-faint">Live debt-market data unavailable for {symbol}.</p>
            )
          ) : company ? (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[
                { label: 'Market cap', value: fmtMarketCap(company.market_cap) },
                { label: 'Beta', value: fmtBeta(company.beta) },
                { label: 'Sector', value: company.sector ?? '—' },
              ].map(({ label, value }) => (
                <div key={label} className="bg-card border border-line rounded-[8px] p-4 flex flex-col gap-1">
                  <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-faint">{label}</span>
                  <span className="font-mono text-[15px] font-medium text-ink tabular-nums">{String(value)}</span>
                </div>
              ))}
            </div>
          ) : companyLoading ? (
            <div className="h-24 bg-line animate-pulse rounded-[8px]" />
          ) : (
            <p className="font-sans text-[14px] text-ink-faint">Company data unavailable.</p>
          )}
        </div>
      )}

      {tab === 'valuation' && (
        <div>
          {valuationLoading && (
            <div className="flex justify-center py-16">
              <span className="w-6 h-6 rounded-full border-2 border-jade border-t-transparent animate-spin" />
            </div>
          )}
          {valuationError && (
            <p className="font-sans text-[14px] text-loss" role="alert">{valuationError}</p>
          )}
          {valuation && <ValuationCard data={valuation} className="max-w-none" />}
          {valuation && (
            <button type="button" onClick={() => askRaabta('valuation')} className={askButtonClass}>
              💬 Explain this with Raabta AI
            </button>
          )}
        </div>
      )}

      {tab === 'technical' && (
        <div>
          {technicalLoading && (
            <div className="flex justify-center py-16">
              <span className="w-6 h-6 rounded-full border-2 border-jade border-t-transparent animate-spin" />
            </div>
          )}
          {technicalError && (
            <p className="font-sans text-[14px] text-loss" role="alert">{technicalError}</p>
          )}
          {technical?.disabled ? (
            <p className="font-sans text-[14px] text-ink-faint">{technical.reason}</p>
          ) : (
            technical && <TechnicalCard data={technical} className="max-w-none" />
          )}
          {technical && !technical.disabled && (
            <button type="button" onClick={() => askRaabta('technical')} className={askButtonClass}>
              💬 Explain this with Raabta AI
            </button>
          )}
        </div>
      )}

      {tab === 'news' && (
        <div>
          {newsLoading ? (
            <div className="flex justify-center py-16">
              <span className="w-6 h-6 rounded-full border-2 border-jade border-t-transparent animate-spin" />
            </div>
          ) : newsItems.length === 0 ? (
            <p className="font-sans text-[14px] text-ink-faint py-8 text-center">
              No news found for {symbol}.
            </p>
          ) : (
            <div className="flex flex-col divide-y divide-line-soft bg-card border border-line rounded-[10px] overflow-hidden">
              {newsItems.map((item, i) => (
                <a
                  key={i}
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-4 py-4 flex items-start gap-3 hover:bg-jade-soft transition-colors"
                >
                  <span
                    className={cn(
                      'font-mono text-[16px] shrink-0 mt-0.5',
                      item.impact === 'positive' ? 'text-gain' : item.impact === 'negative' ? 'text-loss' : 'text-ink-faint',
                    )}
                    aria-label={`Impact: ${item.impact}`}
                  >
                    {IMPACT_SYMBOL[item.impact]}
                  </span>
                  <div className="flex flex-col gap-1 min-w-0">
                    <p className="font-sans text-[14px] text-ink leading-[1.4]">{item.headline}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="font-mono text-[11px] text-ink-faint">{item.source}</span>
                      <Badge variant="neutral">
                        {item.impact_level.charAt(0).toUpperCase() + item.impact_level.slice(1)}
                      </Badge>
                    </div>
                  </div>
                </a>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
