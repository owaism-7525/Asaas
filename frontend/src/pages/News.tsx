import { useEffect, useRef, useState } from 'react'
import { triggerNewsScrape, getScrapeStatus } from '@/lib/api'
import { useNewsFeed } from '@/lib/queries'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { NewsItemResponse } from '@/types/api'

type FilterLevel = 'all' | 'direct' | 'sector' | 'macro'
type FilterMood = 'all' | 'positive' | 'negative' | 'neutral'

const FILTERS: { value: FilterLevel; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'direct', label: 'Direct' },
  { value: 'sector', label: 'Sector' },
  { value: 'macro', label: 'Macro' },
]

const MOOD_FILTERS: { value: FilterMood; label: string }[] = [
  { value: 'all', label: 'Any mood' },
  { value: 'positive', label: '▲ Bullish' },
  { value: 'negative', label: '▼ Bearish' },
  { value: 'neutral', label: '→ Neutral' },
]

const IMPACT_SYMBOL: Record<string, string> = {
  positive: '↑',
  negative: '↓',
  neutral: '→',
}

const IMPACT_BADGE: Record<string, 'gain' | 'loss' | 'neutral'> = {
  positive: 'gain',
  negative: 'loss',
  neutral: 'neutral',
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-PK', { month: 'short', day: 'numeric', year: 'numeric' })
}

export default function News() {
  const newsQ = useNewsFeed()
  const items: NewsItemResponse[] = newsQ.data ?? []
  const loading = newsQ.status === 'pending'
  const [filter, setFilter] = useState<FilterLevel>('all')
  const [mood, setMood] = useState<FilterMood>('all')
  const [refreshing, setRefreshing] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadFeed = () => { void newsQ.refetch() }

  // Clean up any in-flight poll on unmount.
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current) }, [])

  const handleRefresh = () => {
    if (refreshing) return
    setRefreshing(true)
    setProgress(null)
    triggerNewsScrape().catch(() => {})

    // Poll scrape status (~3s) instead of a blind 45s wait. Reload the feed as
    // sources land and stop the moment the scrape reports done (cap ~90s).
    const startedAt = Date.now()
    const stop = () => {
      if (pollRef.current) clearInterval(pollRef.current)
      pollRef.current = null
      setRefreshing(false)
      setProgress(null)
    }
    pollRef.current = setInterval(async () => {
      // Tab hidden → skip this tick (no API calls); polling resumes on return.
      if (document.hidden) {
        if (Date.now() - startedAt > 90000) stop()
        return
      }
      try {
        const s = await getScrapeStatus()
        if (s.state === 'running' && s.sources_total) {
          setProgress(`${s.sources_done ?? 0}/${s.sources_total} sources`)
          loadFeed() // incremental: surface items as each source lands
        }
        if (s.state === 'done' || Date.now() - startedAt > 90000) {
          loadFeed()
          stop()
        }
      } catch {
        if (Date.now() - startedAt > 90000) stop()
      }
    }, 3000)
  }

  // "Affect on my portfolio?" — open Raabta AI seeded with this specific headline only.
  const askAffect = (item: NewsItemResponse) => {
    const syms = item.affected_symbols?.length ? ` Symbols mentioned: ${item.affected_symbols.join(', ')}.` : ''
    const message =
      `Analyse only this single news item and its impact on my portfolio holdings: "${item.headline}".${syms} ` +
      `Which of my holdings are affected, and should I be concerned? Do not discuss any other news.`
    window.dispatchEvent(new CustomEvent('raabta:ask', { detail: { message } }))
  }

  const visible = items.filter(
    (i) =>
      (filter === 'all' || i.impact_level === filter) &&
      (mood === 'all' || (i.impact ?? 'neutral') === mood),
  )

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="font-display text-[28px] font-semibold text-ink">News feed</h1>
          <p className="font-sans text-[14px] text-ink-soft mt-1">
            Events affecting your holdings, sector, and macro environment.
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <Button
            variant="ghost"
            onClick={handleRefresh}
            disabled={refreshing}
            className="text-[12px] btn-press min-w-[120px]"
          >
            {refreshing ? `⏳ Scraping…${progress ? ` ${progress}` : ''}` : '🔄 Refresh'}
          </Button>
        </div>
      </div>

      {/* Filter pills */}
      <div className="flex gap-2 flex-wrap" role="group" aria-label="Filter news by scope">
        {FILTERS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            onClick={() => setFilter(value)}
            className={cn(
              'px-4 py-1.5 rounded-full font-mono text-[12px] uppercase tracking-[0.12em] border transition-colors min-h-[36px]',
              'focus-visible:outline-2 focus-visible:outline-jade focus-visible:outline-offset-2',
              filter === value
                ? 'bg-jade text-white border-jade'
                : 'bg-card text-ink-soft border-line hover:border-jade-soft',
            )}
            aria-pressed={filter === value}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Mood (sentiment) filter pills */}
      <div className="flex gap-2 flex-wrap" role="group" aria-label="Filter news by sentiment">
        {MOOD_FILTERS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            onClick={() => setMood(value)}
            className={cn(
              'px-4 py-1.5 rounded-full font-mono text-[12px] uppercase tracking-[0.12em] border transition-colors min-h-[36px]',
              'focus-visible:outline-2 focus-visible:outline-jade focus-visible:outline-offset-2',
              mood === value
                ? 'bg-jade text-white border-jade'
                : 'bg-card text-ink-soft border-line hover:border-jade-soft',
            )}
            aria-pressed={mood === value}
          >
            {label}
          </button>
        ))}
      </div>

      {/* List */}
      {loading ? (
        <div className="flex justify-center py-16">
          <span className="w-6 h-6 rounded-full border-2 border-jade border-t-transparent animate-spin" />
        </div>
      ) : visible.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-20 text-center">
          <p className="font-display text-[20px] font-semibold text-ink-soft">No news here</p>
          <p className="font-sans text-[14px] text-ink-faint">
            {filter === 'all'
              ? 'No news items for your portfolio yet.'
              : `No ${filter} news found. Try another filter.`}
          </p>
        </div>
      ) : (
        <div className="flex flex-col divide-y divide-line-soft bg-card border border-line rounded-[10px] overflow-hidden">
          {visible.map((item, i) => (
            <div
              key={i}
              className="px-4 py-4 flex items-start gap-4"
            >
              {/* Impact symbol */}
              <span
                className={cn(
                  'font-mono text-[18px] shrink-0 mt-0.5 w-6 text-center',
                  item.impact === 'positive' ? 'text-gain' : item.impact === 'negative' ? 'text-loss' : 'text-ink-faint',
                )}
                aria-label={`Impact: ${item.impact}`}
              >
                {IMPACT_SYMBOL[item.impact ?? 'neutral']}
              </span>

              <div className="flex flex-col gap-1 min-w-0 flex-1">
                <p className="font-sans text-[15px] text-ink leading-[1.4]">{item.headline}</p>
                <div className="flex items-center gap-2 flex-wrap mt-0.5">
                  <span className="font-mono text-[11px] text-ink-faint">{item.source}</span>
                  <Badge variant={IMPACT_BADGE[item.impact] ?? 'neutral'}>
                    {(item.impact ?? 'neutral').charAt(0).toUpperCase() + (item.impact ?? 'neutral').slice(1)}
                  </Badge>
                  <Badge variant="neutral">
                    {(item.impact_level ?? 'macro').charAt(0).toUpperCase() + (item.impact_level ?? 'macro').slice(1)}
                  </Badge>
                  {item.affected_symbols?.map((sym) => (
                    <Badge key={sym} variant="info">
                      {sym}
                    </Badge>
                  ))}
                  <span className="font-mono text-[11px] text-ink-faint ml-auto">
                    {formatDate(item.published_at)}
                  </span>
                </div>

                {/* Two actions: ask the AI how it affects the portfolio, or read the source */}
                <div className="flex items-center gap-2 mt-2">
                  <button
                    type="button"
                    onClick={() => askAffect(item)}
                    className="font-mono text-[11px] px-2.5 py-1 rounded-full bg-jade text-white hover:bg-jade-dark transition-colors btn-press"
                  >
                    💬 Affect on my portfolio?
                  </button>
                  {item.url && (
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-[11px] px-2.5 py-1 rounded-full border border-line text-ink-soft hover:border-jade-soft hover:text-ink transition-colors"
                    >
                      ↗ Full read
                    </a>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
