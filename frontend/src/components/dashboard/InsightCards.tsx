import { useMemo, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowRight, Sparkles } from 'lucide-react'
import { AllocationDonut, assetClassLabel, assetClassToken } from '@/components/charts/AllocationDonut'
import type { HoldingResponse, PortfolioResponse } from '@/types/api'
import { AssetChip, DashCard, Eyebrow, Money, Skel, fmtAmount } from './primitives'
import { RiskGauge, riskBand } from './RiskGauge'

/* ─── Risk score gauge ───────────────────────────────────────────────────── */

export function RiskCard({ portfolio, ready }: { portfolio: PortfolioResponse | null; ready: boolean }) {
  const navigate = useNavigate()
  const score = portfolio ? Math.min(parseFloat(portfolio.expected_risk) * 100, 100) : null
  const band = score != null ? riskBand(score) : null
  const expRet = portfolio ? parseFloat(portfolio.expected_return) * 100 : null
  const sharpe = portfolio ? parseFloat(portfolio.sharpe) : null
  const rf = portfolio?.risk_free_rate ? parseFloat(portfolio.risk_free_rate) * 100 : null

  return (
    <DashCard className="flex flex-col">
      <Eyebrow>Risk score</Eyebrow>
      {!ready ? <Skel className="h-[130px] w-full" /> : (
        <div className="flex flex-col items-center">
          <RiskGauge value={score} size={200} />
          <div className="flex items-baseline gap-1.5 mt-2">
            <span className="font-display text-[36px] leading-none font-semibold text-ink tabular-nums">
              {score != null ? Math.round(score) : '—'}
            </span>
            <span className="font-mono text-[11px] text-ink-faint">/ 100</span>
          </div>
        </div>
      )}
      {band && <p className={`text-center font-mono text-[11px] uppercase tracking-[0.12em] mt-1 ${band.tone}`}>{band.label}</p>}

      <div className="grid grid-cols-3 gap-2 mt-4 pt-4 border-t border-line-soft">
        {[
          { k: 'Expected p.a.', v: expRet != null ? `${expRet.toFixed(1)}%` : '—' },
          { k: 'Sharpe', v: sharpe != null ? sharpe.toFixed(2) : '—' },
          { k: 'SBP rate', v: rf != null ? `${rf.toFixed(2)}%` : '—' },
        ].map((m) => (
          <div key={m.k} className="flex flex-col gap-0.5 min-w-0">
            <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-ink-faint truncate">{m.k}</span>
            <span className="font-mono text-[14px] tabular-nums text-ink">{m.v}</span>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => navigate('/chat', { state: { seedMessage: 'Why is my risk score what it is? Explain the factors.' } })}
        className="mt-4 self-start font-mono text-[11px] text-jade hover:underline focus-visible:outline-2 focus-visible:outline-jade rounded"
      >
        Why this score? Ask the agent →
      </button>
    </DashCard>
  )
}

/* ─── Allocation donut by asset class ────────────────────────────────────── */

export function AllocationCard({ holdings, investments }: { holdings: HoldingResponse[]; investments: number | null }) {
  // Legend groups by asset class so every dot matches its slice colour.
  const groups = useMemo(() => {
    const m = new Map<string, number>()
    holdings.forEach((h) => {
      const ac = (h.asset_class ?? 'other').toLowerCase()
      m.set(ac, (m.get(ac) ?? 0) + h.weight)
    })
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [holdings])

  return (
    <DashCard className="flex flex-col">
      <Eyebrow>Allocation</Eyebrow>
      <div className="flex justify-center">
        <AllocationDonut
          holdings={holdings}
          size={150}
          centerLabel="Invested"
          centerValue={investments != null ? <Money value={investments} compact symbolClassName="text-[0.75em]" /> : undefined}
        />
      </div>
      <ul className="flex flex-col gap-2 mt-4">
        {groups.map(([ac, w]) => (
          <li key={ac} className="flex items-center gap-2.5">
            <AssetChip assetClass={ac} size={22} />
            <span className="font-sans text-[13px] text-ink-soft flex-1 truncate">{assetClassLabel(ac)}</span>
            <span className="w-16 h-1.5 rounded-full bg-line-soft overflow-hidden" aria-hidden>
              <span className="block h-full rounded-full" style={{ width: `${w * 100}%`, backgroundColor: `rgb(var(${assetClassToken(ac)}))` }} />
            </span>
            <span className="font-mono text-[12px] text-ink tabular-nums w-12 text-right">{(w * 100).toFixed(1)}%</span>
          </li>
        ))}
      </ul>
    </DashCard>
  )
}

/* ─── the one bold jade feature card ─────────────────────────────────────── */

function buildPrompts(holdings: HoldingResponse[], cash: number | null): { headline: ReactNode; seed: string; chips: string[] } {
  const sym = (h?: HoldingResponse) => (h?.symbol ?? '').replace('.KA', '')
  const stock = holdings.find((h) => (h.asset_class ?? '').includes('stock') || (h.symbol ?? '').endsWith('.KA'))
  const tbill = holdings.find((h) => ['tbill', 'bond'].includes(h.asset_class ?? ''))
  const crypto = holdings.find((h) => h.asset_class === 'crypto')

  const chips: string[] = []
  if (stock) chips.push(`Value ${sym(stock)}`)
  if (tbill) chips.push(`SBP rate impact on ${sym(tbill)}`)
  if (crypto) chips.push(`RSI for ${sym(crypto)}`)
  chips.push('Market sentiment')

  if (cash != null && cash > 0) {
    const amount = `₨${fmtAmount(cash)}`
    return {
      // ₨ via <Money> so Fraunces doesn't draw it as "Rs".
      headline: <>What should I do with <Money value={cash} symbolClassName="text-[0.8em]" /> in cash?</>,
      seed: `I have ${amount} of uninvested cash. Given my risk profile and current holdings, how should I deploy it?`,
      chips: chips.slice(0, 3),
    }
  }
  return {
    headline: 'How is my portfolio doing — and what should I improve?',
    seed: 'How is my portfolio doing and what should I improve?',
    chips: chips.slice(0, 3),
  }
}

export function AskAsaasCard({ holdings, cash }: { holdings: HoldingResponse[]; cash: number | null }) {
  const navigate = useNavigate()
  const { headline, seed, chips } = useMemo(() => buildPrompts(holdings, cash), [holdings, cash])
  const ask = (message: string) => navigate('/chat', { state: { seedMessage: message } })

  return (
    <DashCard tone="jade" className="w-full flex flex-col justify-between gap-6 relative overflow-hidden">
      {/* soft decorative rings */}
      <span className="pointer-events-none absolute -right-16 -top-16 w-48 h-48 rounded-full border border-white/10" aria-hidden />
      <span className="pointer-events-none absolute -right-8 -top-8 w-32 h-32 rounded-full border border-white/10" aria-hidden />

      <div className="flex flex-col gap-3 relative">
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/70 flex items-center gap-1.5">
          <Sparkles size={12} aria-hidden /> Ask Asaas
        </p>
        <p className="font-display text-[24px] leading-[1.2] font-semibold">{headline}</p>
        <p className="font-sans text-[13px] text-white/75">
          Your agent reads your holdings, the SBP rate and live prices — it suggests, you decide.
        </p>
      </div>

      <div className="flex flex-col gap-3 relative">
        <div className="flex flex-wrap gap-1.5">
          {chips.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => ask(c)}
              className="font-mono text-[11px] px-2.5 py-1 rounded-full bg-white/10 hover:bg-white/20 transition-colors focus-visible:outline-2 focus-visible:outline-white"
            >
              {c}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => ask(seed)}
          className="self-start inline-flex items-center gap-2 rounded-md bg-white text-[#0F6E56] px-4 py-2 font-sans text-[14px] font-semibold hover:bg-white/90 transition-colors btn-press focus-visible:outline-2 focus-visible:outline-white focus-visible:outline-offset-2"
        >
          New analysis <ArrowRight size={15} aria-hidden />
        </button>
      </div>
    </DashCard>
  )
}
