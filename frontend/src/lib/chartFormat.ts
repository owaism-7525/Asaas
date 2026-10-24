/**
 * Chart.js axis helpers shared by the money charts.
 *
 * The old tick formatter rounded every tick to whole thousands, so a series
 * spanning ₨40.1K–41.0K printed "₨41K" five times. These pick the decimals
 * from the actual tick step so neighbouring ticks are always distinct.
 */

type Tick = { value: number }

/** Compact rupee tick: precision follows the step between ticks. */
export function pkrTick(value: number | string, index: number, ticks: Tick[]): string {
  const v = Number(value)
  const step = ticks.length > 1 ? Math.abs(ticks[1].value - ticks[0].value) : Math.abs(v)
  const [div, unit] =
    Math.abs(v) >= 1e9 ? [1e9, 'B'] : Math.abs(v) >= 1e6 ? [1e6, 'M'] : Math.abs(v) >= 1e3 ? [1e3, 'K'] : [1, '']
  const scaledStep = step / div
  const decimals = scaledStep >= 1 || scaledStep === 0 ? 0 : Math.min(3, Math.ceil(-Math.log10(scaledStep)))
  return `₨${(v / div).toFixed(decimals)}${unit}`
}

/** Y-axis bounds hugging the data with ~8% padding (never a flat 0-based axis). */
export function paddedBounds(values: number[]): { min: number; max: number } | undefined {
  const finite = values.filter((v) => Number.isFinite(v))
  if (finite.length === 0) return undefined
  const lo = Math.min(...finite)
  const hi = Math.max(...finite)
  const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.01 || 1
  return { min: lo - pad, max: hi + pad }
}
