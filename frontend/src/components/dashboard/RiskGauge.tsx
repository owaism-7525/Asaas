import { motion } from 'framer-motion'

/**
 * Semicircular 0–100 gauge: hairline track, jade value arc, ink needle.
 * Pure SVG so it inherits theme colours from the CSS tokens.
 */
export function RiskGauge({ value, size = 220 }: { value: number | null; size?: number }) {
  const v = value == null ? 0 : Math.max(0, Math.min(100, value))
  const stroke = 14
  const r = (size - stroke) / 2
  const cx = size / 2
  const cy = size / 2
  const h = size / 2 + stroke  // only the top half is drawn
  const arcLen = Math.PI * r
  const angle = Math.PI * (1 - v / 100)  // 180° (left) → 0° (right)
  const needleLen = r - stroke - 6
  const nx = cx + needleLen * Math.cos(angle)
  const ny = cy - needleLen * Math.sin(angle)
  const arc = `M ${stroke / 2} ${cy} A ${r} ${r} 0 0 1 ${size - stroke / 2} ${cy}`

  return (
    <svg
      viewBox={`0 0 ${size} ${h}`}
      width="100%"
      style={{ maxWidth: size }}
      role="img"
      aria-label={value == null ? 'Risk score unavailable' : `Risk score ${Math.round(v)} out of 100`}
    >
      {/* track */}
      <path d={arc} fill="none" stroke="rgb(var(--line-soft))" strokeWidth={stroke} strokeLinecap="round" />
      {/* band ticks at 33 / 67 */}
      {[1 / 3, 2 / 3].map((f) => {
        const a = Math.PI * (1 - f)
        return (
          <line
            key={f}
            x1={cx + (r - stroke / 2 - 2) * Math.cos(a)} y1={cy - (r - stroke / 2 - 2) * Math.sin(a)}
            x2={cx + (r + stroke / 2 + 2) * Math.cos(a)} y2={cy - (r + stroke / 2 + 2) * Math.sin(a)}
            stroke="rgb(var(--card))" strokeWidth={2.5}
          />
        )
      })}
      {/* value arc */}
      {value != null && (
        <motion.path
          d={arc}
          fill="none"
          stroke="rgb(var(--jade))"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={arcLen}
          initial={{ strokeDashoffset: arcLen }}
          animate={{ strokeDashoffset: arcLen * (1 - v / 100) }}
          transition={{ duration: 0.9, ease: 'easeOut' }}
        />
      )}
      {/* needle */}
      {value != null && (
        <>
          <line x1={cx} y1={cy} x2={nx} y2={ny} stroke="rgb(var(--ink))" strokeWidth={2.5} strokeLinecap="round" />
          <circle cx={cx} cy={cy} r={6} fill="rgb(var(--ink))" />
          <circle cx={cx} cy={cy} r={2.5} fill="rgb(var(--card))" />
        </>
      )}
      <text x={stroke / 2} y={h - 2} fontFamily='"IBM Plex Mono", monospace' fontSize={10} fill="rgb(var(--ink-faint))">0</text>
      <text x={size - stroke / 2} y={h - 2} textAnchor="end" fontFamily='"IBM Plex Mono", monospace' fontSize={10} fill="rgb(var(--ink-faint))">100</text>
    </svg>
  )
}

export function riskBand(v: number): { label: string; tone: string } {
  if (v < 34) return { label: 'Low risk', tone: 'text-gain' }
  if (v < 67) return { label: 'Moderate risk', tone: 'text-gold' }
  return { label: 'High risk', tone: 'text-loss' }
}
