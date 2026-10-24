import { useState } from 'react'
import { reoptimize } from '@/lib/api'
import { usePortfolio, useDiversification } from '@/lib/queries'
import { AllocationDonut } from '@/components/charts/AllocationDonut'
import { OptimizerCard } from '@/components/chat/cards/OptimizerCard'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { PortfolioResponse, DiversificationResponse } from '@/types/api'

function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-faint">{label}</span>
      <span className="font-mono text-[16px] font-medium text-ink tabular-nums">{value}</span>
    </div>
  )
}

export default function PortfolioManagement() {
  const portfolioQ = usePortfolio()
  const portfolio: PortfolioResponse | null = portfolioQ.data ?? null
  const loading = portfolioQ.status === 'pending'
  const [draft, setDraft] = useState<PortfolioResponse | null>(null)
  const [reoptimizing, setReoptimizing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const diversification: DiversificationResponse | null = useDiversification().data ?? null

  const handleReoptimize = async () => {
    setReoptimizing(true)
    setError(null)
    setDraft(null)
    try {
      const result = await reoptimize()
      setDraft(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reoptimization failed.')
    } finally {
      setReoptimizing(false)
    }
  }

  return (
    <div className="flex flex-col gap-8 max-w-2xl">
      <div>
        <h1 className="font-display text-[28px] font-semibold text-ink">Portfolio</h1>
        <p className="font-sans text-[14px] text-ink-soft mt-1">
          Manage your current allocation and run re-optimization.
        </p>
      </div>

      {/* Current portfolio */}
      <section className="flex flex-col gap-4">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-faint">
          Current allocation
        </h2>

        {loading ? (
          <div className="h-40 bg-line animate-pulse rounded-[10px]" />
        ) : !portfolio ? (
          <p className="font-sans text-[14px] text-ink-faint">No portfolio declared yet.</p>
        ) : (
          <div className="bg-card border border-line rounded-[10px] p-5 flex flex-col gap-5">
            <div className="flex items-start gap-6">
              <AllocationDonut holdings={portfolio.holdings} size={160} />
              <div className="flex flex-col gap-3 pt-2">
                <StatCell
                  label="Expected return"
                  value={`${(parseFloat(portfolio.expected_return) * 100).toFixed(1)}%`}
                />
                <StatCell
                  label="Risk (σ)"
                  value={`${(parseFloat(portfolio.expected_risk) * 100).toFixed(1)}%`}
                />
                <StatCell label="Sharpe" value={parseFloat(portfolio.sharpe).toFixed(2)} />
              </div>
            </div>

            {portfolio.concentration_warning && (
              <p className="font-sans text-[13px] text-gold leading-[1.4] border border-gold-soft bg-gold-soft rounded-[6px] px-3 py-2">
                ⚠ {portfolio.concentration_warning}
              </p>
            )}

            <ul className="flex flex-col divide-y divide-line-soft">
              {portfolio.holdings.map((h) => (
                <li key={h.symbol} className="flex items-center justify-between py-2.5 gap-3">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-jade shrink-0" aria-hidden />
                    <span className="font-mono text-[13px] font-semibold text-ink">{h.symbol}</span>
                    <span className="font-sans text-[13px] text-ink-soft">{h.name}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    {h.current_price != null && (
                      <span className="font-mono text-[12px] tabular-nums text-ink-faint">
                        ₨{h.current_price.toLocaleString('en-PK')}
                      </span>
                    )}
                    <span className="font-mono text-[13px] tabular-nums text-ink">
                      {(h.weight * 100).toFixed(1)}%
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* Diversification */}
      {diversification && (
        <section className="flex flex-col gap-4">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-faint">
            Diversification
          </h2>
          <div className="bg-card border border-line rounded-[10px] p-5 flex flex-col gap-3">
            <div className="flex items-end gap-2">
              <span className="font-display text-[32px] font-semibold text-ink leading-[1]">
                {Object.keys(diversification.by_asset_class ?? {}).length}
              </span>
              <span className="font-mono text-[12px] text-ink-faint mb-1">asset classes</span>
              <span className="mx-2 text-ink-faint">·</span>
              <span className="font-display text-[32px] font-semibold text-ink leading-[1]">
                {Object.keys(diversification.by_sector ?? {}).length}
              </span>
              <span className="font-mono text-[12px] text-ink-faint mb-1">sectors</span>
            </div>
            {diversification.warnings?.length > 0 && (
              <ul className="flex flex-col gap-1.5">
                {diversification.warnings.map((w, i) => (
                  <li key={i} className="font-sans text-[12px] text-gold leading-[1.4] flex items-start gap-1.5">
                    <span>⚠</span><span>{w}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}

      {/* Re-optimize */}
      <section className="flex flex-col gap-4">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-faint">
          Re-optimise
        </h2>
        <p className="font-sans text-[14px] text-ink-soft">
          Run MPT re-optimization against current market conditions and your risk profile.
          A new allocation draft will appear below — review before confirming.
        </p>

        {error && (
          <p className="font-sans text-[13px] text-loss" role="alert">{error}</p>
        )}

        <Button
          variant="primary"
          onClick={handleReoptimize}
          disabled={reoptimizing || loading}
          className={cn('self-start', reoptimizing && 'opacity-70')}
        >
          {reoptimizing ? 'Optimising…' : 'Re-optimise now'}
        </Button>
      </section>

      {/* Draft result */}
      {draft && (
        <section className="flex flex-col gap-4">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-faint">
            Suggested new allocation
          </h2>
          <div className="[&_.card-shell]:max-w-none">
            <OptimizerCard data={draft} mode="suggest" />
          </div>
        </section>
      )}

      {/* History placeholder */}
      <section className="flex flex-col gap-4">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-faint">
          Portfolio history
        </h2>
        <div className="bg-card border border-line rounded-[10px] p-5">
          <p className="font-sans text-[14px] text-ink-faint">Portfolio history — coming soon.</p>
        </div>
      </section>
    </div>
  )
}
