import { memo, useMemo, type ReactNode } from 'react'
import { Doughnut } from 'react-chartjs-2'
import {
  Chart as ChartJS,
  ArcElement,
  Tooltip,
} from 'chart.js'
import type { HoldingResponse } from '@/types/api'
import { useTheme } from '@/context/ThemeContext'
import { cssVarRgb } from '@/lib/themeColor'

ChartJS.register(ArcElement, Tooltip)

/**
 * Canonical per-asset-class colour palette — the brand's --ac-* tokens
 * (jade = stocks, plum = crypto, slate = T-bills/bonds, gold = commodities,
 * teal = funds), so charts and chips match and follow light/dark theme.
 */
const ASSET_CLASS_TOKEN: Record<string, string> = {
  equity: '--ac-stock',
  stock: '--ac-stock',
  psx_stock: '--ac-stock',
  global_stock: '--ac-stock',
  crypto: '--ac-crypto',
  tbill: '--ac-tbill',
  bond: '--ac-tbill',
  commodity: '--ac-commodity',
  fund: '--ac-fund',
}

const FALLBACK_TOKEN = '--ink-faint'

/** Human-readable asset-class label used in donut labels and legends. */
export function assetClassLabel(ac?: string): string {
  switch ((ac ?? '').toLowerCase()) {
    case 'equity':
    case 'stock':
    case 'psx_stock': return 'Equity'
    case 'crypto': return 'Crypto'
    case 'tbill': return 'T-Bill'
    case 'bond': return 'Bond'
    case 'commodity': return 'Commodity'
    case 'fund': return 'Fund'
    default: return ac ? ac.charAt(0).toUpperCase() + ac.slice(1) : 'Other'
  }
}

/** Resolved colour for an asset class (reads the live theme's CSS token). */
export function assetClassColor(ac?: string, alpha = 1): string {
  return cssVarRgb(ASSET_CLASS_TOKEN[(ac ?? '').toLowerCase()] ?? FALLBACK_TOKEN, alpha)
}

/** CSS-variable name for an asset class, for Tailwind-free inline styles. */
export function assetClassToken(ac?: string): string {
  return ASSET_CLASS_TOKEN[(ac ?? '').toLowerCase()] ?? FALLBACK_TOKEN
}

/** Build the "SYMBOL (Asset)" label for a holding. */
export function holdingLabel(h: Pick<HoldingResponse, 'symbol' | 'name' | 'asset_class'>): string {
  const sym = h.symbol || h.name || '—'
  return `${sym} (${assetClassLabel(h.asset_class)})`
}

interface AllocationDonutProps {
  /** Holdings-driven mode (default). Labels/colours derived from each holding. */
  holdings?: HoldingResponse[]
  /** Explicit mode — caller supplies parallel arrays. Overrides `holdings`. */
  labels?: string[]
  data?: number[]
  colors?: string[]
  size?: number
  /** Center label override — defaults to "Allocation" */
  centerLabel?: string
  /** Optional value shown under the center label (e.g. total portfolio value). */
  centerValue?: ReactNode
}

function AllocationDonutImpl({
  holdings,
  labels,
  data,
  colors,
  size = 180,
  centerLabel = 'Allocation',
  centerValue,
}: AllocationDonutProps) {
  const { theme } = useTheme()
  const chartData = useMemo(() => {
    // Explicit arrays win; otherwise derive from holdings.
    const finalLabels = labels ?? (holdings ?? []).map((h) => holdingLabel(h))
    const finalData = data ?? (holdings ?? []).map((h) => h.weight * 100)
    const finalColors = colors ?? (holdings ?? []).map((h) => assetClassColor(h.asset_class))
    return {
      labels: finalLabels,
      datasets: [
        {
          data: finalData,
          backgroundColor: finalColors,
          // Segment separators match the card surface so they read as gaps in
          // both light and dark themes (not white slivers on a dark card).
          borderColor: cssVarRgb('--card'),
          borderWidth: 2,
          hoverOffset: 4,
        },
      ],
    }
  }, [holdings, labels, data, colors, theme])

  const options = useMemo(() => ({
    cutout: '68%',
    // Disabled so the donut never re-animates on a parent re-render (no flicker).
    animation: false as const,
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: (ctx: { label: string; raw: unknown }) =>
            `${ctx.label}: ${(ctx.raw as number).toFixed(1)}%`,
        },
      },
    },
  }), [])

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <Doughnut data={chartData} options={options} />
      {/* Center overlay */}
      <div
        className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none"
        aria-hidden="true"
      >
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">
          {centerLabel}
        </span>
        {centerValue && (
          <span className="font-display font-semibold text-ink leading-tight tabular-nums"
            style={{ fontSize: Math.max(13, Math.round(size * 0.13)) }}>
            {centerValue}
          </span>
        )}
      </div>
    </div>
  )
}

export const AllocationDonut = memo(AllocationDonutImpl)
