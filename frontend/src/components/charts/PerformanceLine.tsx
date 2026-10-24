import { memo, useMemo } from 'react'
import {
  Chart as ChartJS,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Tooltip,
  Filler,
} from 'chart.js'
import type { Chart, Plugin, ScriptableContext, TooltipItem } from 'chart.js'
import { Line } from 'react-chartjs-2'
import { useTheme } from '@/context/ThemeContext'
import { cssVarRgb } from '@/lib/themeColor'
import { paddedBounds, pkrTick } from '@/lib/chartFormat'

ChartJS.register(LineElement, PointElement, LinearScale, CategoryScale, Tooltip, Filler)

interface DataPoint {
  date: string
  value: string
}

interface PerformanceLineProps {
  history: DataPoint[]
  height?: number
  lineColor?: string
  /** Mark the highest point with a dot + value callout. */
  showPeak?: boolean
}

const DAY = 86_400_000

const fmtDate = (ts: number) =>
  new Date(ts).toLocaleDateString('en-PK', { month: 'short', day: 'numeric' })

const fmtFull = (n: number) =>
  `₨${Math.round(n).toLocaleString('en-PK', { maximumFractionDigits: 0 })}`

/** Draws a dot on the peak value and a small ink pill above it. */
const peakPlugin: Plugin<'line'> = {
  id: 'asaasPeak',
  afterDatasetsDraw(chart: Chart<'line'>, _args, opts: { enabled?: boolean; color?: string; text?: string; bg?: string }) {
    if (!opts?.enabled) return
    const meta = chart.getDatasetMeta(0)
    const values = chart.data.datasets[0]?.data as { x: number; y: number }[] | undefined
    if (!values?.length || !meta?.data?.length) return
    let iMax = 0
    values.forEach((p, i) => { if (p.y > values[iMax].y) iMax = i })
    const pt = meta.data[iMax]
    if (!pt) return
    const { ctx, chartArea } = chart
    const label = `Peak ${fmtFull(values[iMax].y)}`
    ctx.save()
    ctx.font = '500 11px "IBM Plex Mono", monospace'
    const w = ctx.measureText(label).width + 14
    const h = 20
    const x = Math.min(Math.max(pt.x - w / 2, chartArea.left), chartArea.right - w)
    // Above the dot; the layout's top padding leaves room past chartArea.top.
    const y = Math.max(pt.y - h - 10, 2)
    ctx.fillStyle = opts.bg ?? '#16201C'
    ctx.beginPath()
    ctx.roundRect(x, y, w, h, 10)
    ctx.fill()
    ctx.fillStyle = opts.text ?? '#FFFEFB'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, x + 7, y + h / 2 + 0.5)
    ctx.beginPath()
    ctx.arc(pt.x, pt.y, 4.5, 0, Math.PI * 2)
    ctx.fillStyle = opts.color ?? '#0F6E56'
    ctx.fill()
    ctx.lineWidth = 2
    ctx.strokeStyle = opts.text ?? '#FFFEFB'
    ctx.stroke()
    ctx.restore()
  },
}

function PerformanceLineImpl({ history, height = 240, lineColor, showPeak = false }: PerformanceLineProps) {
  const { theme } = useTheme()
  const line = lineColor ?? cssVarRgb('--jade')

  // Real points only (no NaN / non-positive values), placed on a true time
  // axis so a 7-day gap between snapshots isn't drawn as a one-step cliff.
  const points = useMemo(
    () => history
      .map((d) => ({ x: new Date(d.date).getTime(), y: parseFloat(d.value) }))
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && p.y > 0)
      .sort((a, b) => a.x - b.x),
    [history],
  )

  const data = useMemo(() => ({
    datasets: [
      {
        data: points,
        borderColor: line,
        borderWidth: 2.25,
        cubicInterpolationMode: 'monotone' as const,  // smooth, but never overshoots the data
        fill: true,
        backgroundColor: (c: ScriptableContext<'line'>) => {
          const area = c.chart.chartArea
          if (!area) return cssVarRgb('--jade', 0.12)
          const g = c.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom)
          g.addColorStop(0, cssVarRgb('--jade', 0.12))
          g.addColorStop(1, cssVarRgb('--jade', 0))
          return g
        },
        pointRadius: 0,
        pointHoverRadius: 5,
        pointHoverBackgroundColor: line,
        pointHoverBorderColor: cssVarRgb('--card'),
        pointHoverBorderWidth: 2,
      },
    ],
  }), [points, line, theme])

  const options = useMemo(() => {
    const bounds = paddedBounds(points.map((p) => p.y))
    const spanDays = points.length > 1 ? (points[points.length - 1].x - points[0].x) / DAY : 0
    return {
      // Disabled so the chart never re-animates on a parent re-render (no flicker).
      animation: false as const,
      responsive: true,
      maintainAspectRatio: false,
      parsing: false as const,
      interaction: { mode: 'nearest' as const, axis: 'x' as const, intersect: false },
      layout: { padding: { top: showPeak ? 30 : 4 } },
      plugins: {
        legend: { display: false },
        asaasPeak: { enabled: showPeak, color: line, bg: cssVarRgb('--ink'), text: cssVarRgb('--card') },
        tooltip: {
          backgroundColor: cssVarRgb('--ink'),
          borderColor: cssVarRgb('--line'),
          borderWidth: 1,
          titleColor: cssVarRgb('--ink-faint'),
          bodyColor: cssVarRgb('--paper'),
          titleFont: { family: '"IBM Plex Mono"', size: 11 },
          bodyFont: { family: '"IBM Plex Mono"', size: 13, weight: 500 as const },
          displayColors: false,
          callbacks: {
            title: (items: TooltipItem<'line'>[]) => fmtDate(items[0]?.parsed?.x ?? 0),
            label: (item: TooltipItem<'line'>) => fmtFull(item.parsed?.y ?? 0),
          },
        },
      },
      scales: {
        x: {
          type: 'linear' as const,
          min: points[0]?.x,
          max: points[points.length - 1]?.x,
          grid: { display: false },
          border: { display: false },
          ticks: {
            color: cssVarRgb('--ink-faint'),
            font: { family: '"IBM Plex Mono"', size: 11 },
            maxTicksLimit: 6,
            stepSize: spanDays > 60 ? undefined : DAY,
            maxRotation: 0,
            callback: (v: number | string) => fmtDate(Number(v)),
          },
        },
        y: {
          position: 'left' as const,
          // Suggested (not hard) bounds: hug the data but let ticks land on round values.
          suggestedMin: bounds?.min,
          suggestedMax: bounds?.max,
          grid: { color: cssVarRgb('--line'), lineWidth: 1, drawTicks: false },
          border: { display: false },
          ticks: {
            color: cssVarRgb('--ink-faint'),
            font: { family: '"IBM Plex Mono"', size: 11 },
            maxTicksLimit: 5,
            padding: 8,
            callback: pkrTick,
          },
        },
      },
    }
  }, [points, line, showPeak, theme])

  if (points.length === 0) {
    return (
      <div
        className="flex items-center justify-center bg-card rounded-[10px] border border-line"
        style={{ height }}
      >
        <p className="font-mono text-[12px] text-ink-faint">No performance data yet</p>
      </div>
    )
  }

  return (
    <div style={{ height }}>
      <Line data={data} options={options} plugins={[peakPlugin]} />
    </div>
  )
}

export const PerformanceLine = memo(PerformanceLineImpl)
