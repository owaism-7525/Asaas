import { useMemo } from 'react'
import { Bar } from 'react-chartjs-2'
import { BarElement, CategoryScale, Chart as ChartJS, LinearScale, Tooltip } from 'chart.js'
import type { Chart, Plugin, TooltipItem } from 'chart.js'
import { CalendarDays, Coins, Hourglass, Landmark } from 'lucide-react'
import { PerformanceLine } from '@/components/charts/PerformanceLine'
import { useTheme } from '@/context/ThemeContext'
import { cssVarRgb } from '@/lib/themeColor'
import { paddedBounds, pkrTick } from '@/lib/chartFormat'
import { cn } from '@/lib/utils'
import type { DashboardEvent } from '@/lib/api'
import { DashCard, Eyebrow, Skel, fmtAmount } from './primitives'

ChartJS.register(BarElement, CategoryScale, LinearScale, Tooltip)

type History = { date: string; value: string }[]

/* ─── performance area chart ─────────────────────────────────────────────── */

export type TimeRange = '1w' | '1m' | '6m' | '1y' | 'all'
const RANGES: TimeRange[] = ['1w', '1m', '6m', '1y', 'all']
const RANGE_DAYS: Record<TimeRange, number> = { '1w': 7, '1m': 30, '6m': 180, '1y': 365, all: Infinity }

export function PerformanceCard({ history, ready, range, onRange }: {
  history: History
  ready: boolean
  range: TimeRange
  onRange: (r: TimeRange) => void
}) {
  // Window the real snapshot series; fall back to all history if the window
  // holds fewer than two points (young portfolio) so the chart is never blank.
  const visible = useMemo(() => {
    if (history.length === 0 || range === 'all') return history
    const cutoff = Date.now() - RANGE_DAYS[range] * 86_400_000
    const w = history.filter((h) => new Date(h.date).getTime() >= cutoff)
    return w.length >= 2 ? w : history
  }, [history, range])

  const first = visible.length ? parseFloat(visible[0].value) : null
  const last = visible.length ? parseFloat(visible[visible.length - 1].value) : null
  const change = first && last ? ((last - first) / first) * 100 : null

  return (
    <DashCard className="lg:col-span-2 flex flex-col">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">Performance · investments</p>
          {last != null && (
            <p className="font-display text-[22px] font-semibold text-ink mt-1 flex items-baseline gap-2">
              <span><span className="font-mono font-normal text-[0.7em] text-ink-soft">₨</span>{fmtAmount(last)}</span>
              {change != null && (
                <span className={cn('font-mono text-[12px] font-medium', change >= 0 ? 'text-gain' : 'text-loss')}>
                  {change >= 0 ? '▲ +' : '▼ −'}{Math.abs(change).toFixed(2)}%
                </span>
              )}
            </p>
          )}
        </div>
        <div className="flex gap-1 bg-paper rounded-md p-0.5" role="group" aria-label="Time range">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => onRange(r)}
              aria-pressed={range === r}
              className={cn(
                'px-2.5 py-1 rounded font-mono text-[10px] uppercase tracking-[0.1em] transition-colors btn-press',
                range === r ? 'bg-jade text-white' : 'text-ink-faint hover:text-ink',
              )}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {!ready ? <Skel className="h-[240px] w-full" /> : visible.length > 1 ? (
        <PerformanceLine history={visible} height={240} showPeak />
      ) : (
        <div className="flex items-center justify-center h-[240px]">
          <p className="font-mono text-[12px] text-ink-faint text-center">
            {history.length > 0 ? 'Building history — your portfolio is snapshotted daily.' : 'No performance data yet'}
          </p>
        </div>
      )}
    </DashCard>
  )
}

/* ─── month-end value bars with a peak callout ───────────────────────────── */

const peakLabel: Plugin<'bar'> = {
  id: 'asaasBarPeak',
  afterDatasetsDraw(chart: Chart<'bar'>, _a, opts: { index?: number; text?: string; bg?: string; fg?: string }) {
    if (opts?.index == null || opts.index < 0 || !opts.text) return
    const bar = chart.getDatasetMeta(0).data[opts.index]
    if (!bar) return
    const { ctx, chartArea } = chart
    ctx.save()
    ctx.font = '500 11px "IBM Plex Mono", monospace'
    const w = ctx.measureText(opts.text).width + 14
    const h = 20
    const x = Math.min(Math.max(bar.x - w / 2, chartArea.left), chartArea.right - w)
    const y = Math.max(bar.y - h - 6, 2)
    ctx.fillStyle = opts.bg ?? '#16201C'
    ctx.beginPath()
    ctx.roundRect(x, y, w, h, 10)
    ctx.fill()
    ctx.fillStyle = opts.fg ?? '#FFFEFB'
    ctx.textBaseline = 'middle'
    ctx.fillText(opts.text, x + 7, y + h / 2 + 0.5)
    ctx.restore()
  },
}

export function MonthlyValueCard({ history, ready }: { history: History; ready: boolean }) {
  const { theme } = useTheme()

  // Month-end value = the last snapshot in each calendar month, last 12 months.
  const months = useMemo(() => {
    const byMonth = new Map<string, { t: number; v: number }>()
    history.forEach((h) => {
      const t = new Date(h.date).getTime()
      const v = parseFloat(h.value)
      if (!Number.isFinite(t) || !Number.isFinite(v) || v <= 0) return
      const key = h.date.slice(0, 7)
      const cur = byMonth.get(key)
      if (!cur || t > cur.t) byMonth.set(key, { t, v })
    })
    return [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-12)
  }, [history])

  const peakIdx = months.reduce((best, m, i) => (m[1].v > (months[best]?.[1].v ?? -Infinity) ? i : best), 0)

  const data = useMemo(() => ({
    labels: months.map(([k]) => new Date(`${k}-01`).toLocaleDateString('en-PK', { month: 'short' })),
    datasets: [{
      data: months.map(([, m]) => m.v),
      backgroundColor: months.map((_, i) => (i === peakIdx ? cssVarRgb('--jade') : cssVarRgb('--jade', 0.28))),
      hoverBackgroundColor: cssVarRgb('--jade'),
      borderRadius: 6,
      borderSkipped: false as const,
      maxBarThickness: 28,
    }],
  }), [months, peakIdx, theme])

  const options = useMemo(() => {
    const values = months.map(([, m]) => m.v)
    const b = paddedBounds(values)
    return {
      animation: false as const,
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 24 } },
      plugins: {
        legend: { display: false },
        asaasBarPeak: {
          index: months.length ? peakIdx : -1,
          text: months.length ? `₨${fmtAmount(months[peakIdx][1].v)}` : '',
          bg: cssVarRgb('--ink'),
          fg: cssVarRgb('--card'),
        },
        tooltip: {
          backgroundColor: cssVarRgb('--ink'),
          titleColor: cssVarRgb('--ink-faint'),
          bodyColor: cssVarRgb('--paper'),
          titleFont: { family: '"IBM Plex Mono"', size: 11 },
          bodyFont: { family: '"IBM Plex Mono"', size: 13, weight: 500 as const },
          displayColors: false,
          callbacks: {
            title: (items: TooltipItem<'bar'>[]) => months[items[0]?.dataIndex ?? 0]?.[0] ?? '',
            label: (item: TooltipItem<'bar'>) => `₨${fmtAmount(item.parsed.y ?? 0)} month-end`,
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          border: { display: false },
          ticks: { color: cssVarRgb('--ink-faint'), font: { family: '"IBM Plex Mono"', size: 10 } },
        },
        y: {
          // Bars need a zero floor to compare honestly; tighten only when every month sits far above it.
          suggestedMin: b && b.min > 0 && b.min > (b.max - b.min) * 2 ? b.min : 0,
          suggestedMax: b?.max,
          grid: { color: cssVarRgb('--line'), drawTicks: false },
          border: { display: false },
          ticks: {
            color: cssVarRgb('--ink-faint'),
            font: { family: '"IBM Plex Mono"', size: 10 },
            maxTicksLimit: 5,
            padding: 6,
            callback: pkrTick,
          },
        },
      },
    }
  }, [months, peakIdx, theme])

  return (
    <DashCard className="lg:col-span-2 flex flex-col">
      <Eyebrow action={<span className="font-mono text-[10px] text-ink-faint">month-end · investments</span>}>
        Monthly value
      </Eyebrow>
      {!ready ? <Skel className="h-[200px] w-full" /> : months.length >= 2 ? (
        <div className="h-[200px]"><Bar data={data} options={options} plugins={[peakLabel]} /></div>
      ) : (
        <div className="h-[200px] flex items-center justify-center">
          <p className="font-mono text-[12px] text-ink-faint">Needs at least two months of history.</p>
        </div>
      )}
    </DashCard>
  )
}

/* ─── upcoming events: week strip + list ─────────────────────────────────── */

const EVENT_STYLE: Record<DashboardEvent['type'], { icon: typeof Landmark; chip: string; label: string }> = {
  mpc: { icon: Landmark, chip: 'bg-info-soft text-info', label: 'SBP' },
  maturity: { icon: Hourglass, chip: 'bg-gold-soft text-gold', label: 'Maturity' },
  coupon: { icon: Coins, chip: 'bg-jade-soft text-jade', label: 'Coupon' },
}

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export function EventsCard({ events, ready }: { events: DashboardEvent[]; ready: boolean }) {
  const today = new Date()
  const todayIso = iso(today)
  // Mon–Sun strip for the current week.
  const monday = new Date(today)
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7))
  const week = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday)
    d.setDate(monday.getDate() + i)
    return d
  })
  const eventDays = new Set(events.map((e) => e.date))

  return (
    <DashCard className="flex flex-col">
      <Eyebrow action={<CalendarDays size={14} className="text-ink-faint" aria-hidden />}>Upcoming</Eyebrow>

      <div className="grid grid-cols-7 gap-1 mb-4">
        {week.map((d) => {
          const key = iso(d)
          const isToday = key === todayIso
          return (
            <div
              key={key}
              className={cn(
                'flex flex-col items-center gap-0.5 rounded-md py-1.5',
                isToday ? 'bg-jade text-white' : 'text-ink-soft',
              )}
            >
              <span className={cn('font-mono text-[9px] uppercase', isToday ? 'text-white/80' : 'text-ink-faint')}>
                {d.toLocaleDateString('en-PK', { weekday: 'narrow' })}
              </span>
              <span className="font-mono text-[13px] tabular-nums">{d.getDate()}</span>
              <span className={cn('w-1 h-1 rounded-full', eventDays.has(key) ? (isToday ? 'bg-white' : 'bg-jade') : 'bg-transparent')} />
            </div>
          )
        })}
      </div>

      {!ready ? <Skel className="h-24 w-full" /> : events.length === 0 ? (
        <p className="font-sans text-[13px] text-ink-faint">No dated events in the next 120 days.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {events.slice(0, 4).map((e, i) => {
            const st = EVENT_STYLE[e.type]
            const d = new Date(`${e.date}T00:00:00`)
            const days = Math.round((d.getTime() - new Date(`${todayIso}T00:00:00`).getTime()) / 86_400_000)
            const soon = days <= 7
            return (
              <li
                key={`${e.date}-${e.title}-${i}`}
                className={cn('flex items-center gap-3 rounded-md px-2.5 py-2', soon ? 'bg-jade-soft' : 'bg-paper')}
              >
                <span className={cn('w-8 h-8 rounded-full grid place-items-center shrink-0', st.chip)}>
                  <st.icon size={14} aria-hidden />
                </span>
                <div className="flex-1 min-w-0">
                  <p className="font-sans text-[13px] text-ink truncate">{e.title}</p>
                  <p className="font-mono text-[10px] text-ink-faint truncate">{st.label} · {e.detail}</p>
                </div>
                <div className="text-right shrink-0">
                  <p className="font-mono text-[12px] text-ink tabular-nums">
                    {d.toLocaleDateString('en-PK', { day: 'numeric', month: 'short' })}
                  </p>
                  <p className={cn('font-mono text-[10px]', soon ? 'text-jade font-semibold' : 'text-ink-faint')}>
                    {days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days}d`}
                  </p>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </DashCard>
  )
}
