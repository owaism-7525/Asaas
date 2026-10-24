import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { depositCash, withdrawCash } from '@/lib/api'
import { queryClient, qk, useWallet, useCashTransactions, invalidateCash } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { Money } from '@/components/dashboard/primitives'
import type { CashTransaction } from '@/types/api'

type Panel = 'deposit' | 'withdraw' | null

const inputCls = cn(
  'bg-card border border-line rounded-[6px] px-2 py-2 text-[13px] font-mono tabular-nums text-ink w-full',
  'min-h-[40px] focus-visible:outline-2 focus-visible:outline-jade focus-visible:outline-offset-2',
)
const labelCls = 'font-sans text-[11px] font-medium text-ink mb-1 block'

const fmtPkr = (v: string | number) => {
  const n = typeof v === 'string' ? parseFloat(v) : v
  return `₨${Math.round(n).toLocaleString('en-PK', { maximumFractionDigits: 0 })}`
}

// deposit / sell add cash; withdrawal / buy remove it
const CREDIT_TYPES = new Set(['deposit', 'sell'])

const TXN_LABEL: Record<string, string> = {
  deposit: 'Deposit',
  withdrawal: 'Withdraw',
  buy: 'Buy',
  sell: 'Sell',
}

export function WalletCard() {
  // Shared cache: the Dashboard reads the same wallet query for its total value,
  // and buys/sells elsewhere invalidate it.
  const balance = useWallet().data?.balance ?? null
  const txns: CashTransaction[] = useCashTransactions(10).data?.items ?? []
  const [panel, setPanel] = useState<Panel>(null)
  const [amount, setAmount] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const openPanel = (p: Panel) => {
    setError(null)
    setAmount('')
    setPanel(panel === p ? null : p)
  }

  async function submit() {
    setSubmitting(true)
    setError(null)
    try {
      const fn = panel === 'deposit' ? depositCash : withdrawCash
      const w = await fn(amount)
      queryClient.setQueryData(qk.wallet, w)
      setPanel(null)
      setAmount('')
      await invalidateCash()
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Something went wrong.')
    } finally {
      setSubmitting(false)
    }
  }

  const amountValid = parseFloat(amount) > 0

  return (
    <div className="bg-card border border-line rounded-lg shadow-sm p-5">
      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint mb-3">Cash Wallet</p>

      <div className="flex items-end gap-2 mb-3">
        <span className="font-display text-[26px] leading-[1] font-semibold text-ink tabular-nums">
          {balance === null ? '—' : <Money value={parseFloat(balance)} symbolClassName="text-[0.65em] text-ink-soft mr-0.5" />}
        </span>
        <span className="font-mono text-[11px] text-ink-faint mb-0.5">PKR</span>
      </div>

      <div className="flex gap-2 mb-3">
        <Button variant={panel === 'deposit' ? 'primary' : 'outline'} size="sm" onClick={() => openPanel('deposit')}>
          Deposit
        </Button>
        <Button variant={panel === 'withdraw' ? 'primary' : 'outline'} size="sm" onClick={() => openPanel('withdraw')}>
          Withdraw
        </Button>
      </div>

      {panel && (
        <div className="border border-line rounded-[10px] p-3 flex flex-col gap-2 mb-3">
          <div>
            <label className={labelCls}>Amount (₨)</label>
            <input
              className={inputCls}
              type="number"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => { setAmount(e.target.value); setError(null) }}
            />
          </div>
          {error && <p className="font-sans text-[12px] text-loss" role="alert">{error}</p>}
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" size="sm" onClick={() => setPanel(null)} disabled={submitting}>Cancel</Button>
            <Button variant="primary" size="sm" onClick={submit} disabled={!amountValid || submitting}>
              {submitting ? 'Saving…' : panel === 'deposit' ? 'Deposit' : 'Withdraw'}
            </Button>
          </div>
        </div>
      )}

      {txns.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {txns.map((t) => {
            const credit = CREDIT_TYPES.has(t.type)
            return (
              <div key={t.id} className="flex items-center justify-between gap-2">
                <span className="font-mono text-[11px] text-ink-soft truncate">
                  {TXN_LABEL[t.type] ?? t.type}
                  {t.symbol ? ` · ${t.symbol}` : ''}
                </span>
                <span className={cn('font-mono text-[11px] tabular-nums shrink-0', credit ? 'text-jade' : 'text-loss')}>
                  {credit ? '+' : '−'}{fmtPkr(t.amount)}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
