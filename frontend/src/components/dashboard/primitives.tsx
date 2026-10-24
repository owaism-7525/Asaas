import type { ReactNode } from 'react'
import { motion, type Variants } from 'framer-motion'
import { ArrowDownRight, ArrowUpRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { assetClassLabel, assetClassToken } from '@/components/charts/AllocationDonut'

/* ─── number formatting — one precision rule for the whole dashboard ─────── */

/** Whole rupees with separators: 76735.9 → "76,736". */
export function fmtAmount(n: number): string {
  return Math.round(n).toLocaleString('en-PK', { maximumFractionDigits: 0 })
}

/** Compact rupees for tight spots (chart ticks, cells): 40139 → "40.1K". */
export function fmtCompact(n: number): string {
  const a = Math.abs(n)
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (a >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return fmtAmount(n)
}

/**
 * Rupee amount. The ₨ sign is always set in IBM Plex Mono: Fraunces draws
 * U+20A8 as "Rs", which made display numbers disagree with the rest of the app.
 */
export function Money({ value, compact = false, className, symbolClassName }: {
  value: number
  compact?: boolean
  className?: string
  symbolClassName?: string
}) {
  return (
    <span className={cn('tabular-nums whitespace-nowrap', className)}>
      {value < 0 && '−'}
      <span className={cn('font-mono font-normal', symbolClassName)}>₨</span>
      {compact ? fmtCompact(Math.abs(value)) : fmtAmount(Math.abs(value))}
    </span>
  )
}

/* ─── card shell ─────────────────────────────────────────────────────────── */

export const gridStagger: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.06 } },
}

const cardEnter: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.32, ease: 'easeOut' } },
}

/** Paper card with a hairline border, soft shadow and a subtle hover-lift.
 *  Motion respects prefers-reduced-motion via the page's <MotionConfig>. */
export function DashCard({ children, className, tone = 'paper' }: {
  children: ReactNode
  className?: string
  tone?: 'paper' | 'jade'
}) {
  return (
    <motion.section
      variants={cardEnter}
      whileHover={{ y: -3 }}
      transition={{ type: 'tween', duration: 0.18 }}
      className={cn(
        'rounded-lg p-5 min-w-0 transition-shadow duration-200 hover:shadow',
        // Deep brand jade in both themes: dark-mode --jade is too light for white text.
        tone === 'jade'
          ? 'bg-[#0F6E56] text-white shadow-sm'
          : 'bg-card border border-line shadow-sm',
        className,
      )}
    >
      {children}
    </motion.section>
  )
}

export function Eyebrow({ children, className, action }: {
  children: ReactNode
  className?: string
  action?: ReactNode
}) {
  return (
    <div className={cn('flex items-center justify-between gap-2 mb-3', className)}>
      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">{children}</p>
      {action}
    </div>
  )
}

/* ─── gain / loss pill — colour is always paired with an arrow and sign ──── */

export function DeltaPill({ value, suffix = '%', digits = 2, className }: {
  value: number
  suffix?: string
  digits?: number
  className?: string
}) {
  const up = value >= 0
  const Arrow = up ? ArrowUpRight : ArrowDownRight
  return (
    <span className={cn(
      'inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 font-mono text-[11px] tabular-nums font-medium',
      up ? 'bg-jade-soft text-gain' : 'bg-loss-soft text-loss',
      className,
    )}>
      <Arrow size={12} aria-hidden />
      {up ? '+' : '−'}{Math.abs(value).toFixed(digits)}{suffix}
    </span>
  )
}

/* ─── asset-class chip: the dashboard's colour language ──────────────────── */

const AC_INITIAL: Record<string, string> = {
  equity: 'S', stock: 'S', psx_stock: 'S', global_stock: 'S',
  crypto: 'C', tbill: 'T', bond: 'B', commodity: 'G', fund: 'F',
}

/** Small round chip in the asset class's brand colour (jade stocks, plum
 *  crypto, slate T-bills, gold commodities, teal funds). */
export function AssetChip({ assetClass, size = 28 }: { assetClass?: string; size?: number }) {
  const token = assetClassToken(assetClass)
  const key = (assetClass ?? '').toLowerCase()
  return (
    <span
      className="inline-grid place-items-center rounded-full shrink-0 font-mono font-semibold"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.4,
        backgroundColor: `rgb(var(${token}) / 0.14)`,
        color: `rgb(var(${token}))`,
      }}
      title={assetClassLabel(assetClass)}
      aria-label={assetClassLabel(assetClass)}
    >
      {AC_INITIAL[key] ?? '•'}
    </span>
  )
}

export function Skel({ className }: { className?: string }) {
  return <div className={cn('skeleton rounded-[6px]', className)} />
}
