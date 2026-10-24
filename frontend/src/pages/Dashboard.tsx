import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { MotionConfig, motion } from 'framer-motion'
import { useAuth } from '@/context/AuthContext'
import { getProfile } from '@/lib/api'
import {
  queryClient,
  qk,
  usePortfolio,
  usePerformance,
  useNewsFeed,
  useFlags,
  useWallet,
  useEvents,
  invalidateHoldings,
} from '@/lib/queries'
import { MyActivity } from '@/components/layout/MyActivity'
import { WalletCard } from '@/components/layout/WalletCard'
import { MarketSentimentGauge } from '@/components/layout/MarketSentimentGauge'
import { RiskPanel } from '@/components/layout/RiskPanel'
import { HeroStats } from '@/components/dashboard/HeroStats'
import { AllocationCard, AskAsaasCard, RiskCard } from '@/components/dashboard/InsightCards'
import { EventsCard, MonthlyValueCard, PerformanceCard, type TimeRange } from '@/components/dashboard/ActivityCards'
import { FeedCard, HoldingsCard } from '@/components/dashboard/HoldingsCard'
import { DashCard, gridStagger } from '@/components/dashboard/primitives'

/* ─── Dashboard ───────────────────────────────────────────────────────── */

export default function Dashboard() {
  const navigate = useNavigate()
  const { loading: authLoading } = useAuth()

  // All data comes from the shared query cache: whatever another page (or the
  // sign-in redirect) already loaded renders instantly, then refreshes in the
  // background. Each card renders as soon as its own query resolves.
  const enabled = !authLoading   // wait for Supabase session to settle
  const portfolioQ = usePortfolio({ enabled })
  const perfQ = usePerformance({ enabled })
  const newsQ = useNewsFeed({ enabled })
  const flagsQ = useFlags({ enabled })
  const walletQ = useWallet({ enabled })
  const eventsQ = useEvents({ enabled })

  const portfolio = portfolioQ.data ?? null
  const perf = perfQ.data ?? null
  const news = newsQ.data ?? []
  const flags = flagsQ.data ?? []
  const events = eventsQ.data?.events ?? []
  const cashBalance = walletQ.data ? parseFloat(walletQ.data.balance) : null
  const portfolioReady = portfolioQ.status !== 'pending'
  const perfReady = perfQ.status !== 'pending'
  const [range, setRange] = useState<TimeRange>('1m')

  const portfolioStatus = (portfolioQ.error as { status?: number } | null)?.status
  // Distinguishes a transient load failure (server briefly unreachable) from
  // genuinely having no portfolio — so a 500/network blip never shows the
  // "Build your first portfolio" empty state.
  const loadError = portfolioQ.isError && portfolioStatus !== 404

  // 404 = genuinely no active portfolio → onboarding.
  useEffect(() => {
    if (portfolioStatus !== 404) return
    let cancelled = false
    queryClient.ensureQueryData({ queryKey: qk.profile, queryFn: getProfile })
      .then(() => { if (!cancelled) navigate('/onboarding/suggest', { replace: true }) })
      .catch(() => { if (!cancelled) navigate('/onboarding', { replace: true }) })
    return () => { cancelled = true }
  }, [portfolioStatus, navigate])

  // After a portfolio-activity change (buy/sell/edit), refresh everything
  // derived from holdings or cash; usePerformance upgrades to live figures.
  async function refresh() {
    await invalidateHoldings()
  }

  /* derived */
  const num = (s?: string | null) => (s != null && s !== '' ? parseFloat(s) : null)
  const pnlAbs = num(perf?.pnl_absolute)
  const pnlPct = num(perf?.pnl_percent)
  const investments = num(perf?.total_value)
  const invested = num(perf?.total_cost)
  // Headline number = investments + available cash (deposits show up immediately)
  const totalWithCash = investments !== null || cashBalance !== null
    ? (investments ?? 0) + (cashBalance ?? 0)
    : null
  const holdings = portfolio?.holdings ?? []
  const history = perf?.history ?? []

  /* ── non-happy states ── */
  if (portfolioReady && !portfolio) {
    return (
      <div className="flex flex-col gap-3 py-10">
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">Portfolio</p>
        {loadError ? (
          <>
            <p className="font-sans text-[14px] text-loss">
              Couldn't load your portfolio — the server was briefly unreachable. Your portfolio is safe.
            </p>
            <button
              type="button"
              onClick={() => { void portfolioQ.refetch() }}
              className="self-start font-mono text-[12px] text-jade hover:underline focus-visible:outline-2 focus-visible:outline-jade rounded"
            >
              ↻ Retry
            </button>
          </>
        ) : (
          <p className="font-sans text-[14px] text-ink-faint">
            No portfolio yet.{' '}
            <button
              type="button"
              onClick={() => navigate('/onboarding')}
              className="text-jade hover:underline focus-visible:outline-2 focus-visible:outline-jade rounded"
            >
              Build your first portfolio
            </button>
          </p>
        )}
      </div>
    )
  }

  /* ── render ── */
  return (
    <MotionConfig reducedMotion="user">
      <motion.div
        className="flex flex-col gap-5 pb-20 md:pb-6"
        variants={gridStagger}
        initial="hidden"
        animate="show"
      >
        {/* Row 0 — hero value + 2×2 stat cards */}
        <HeroStats
          name={portfolio ? (portfolio.name || `${portfolio.holdings.length} holdings`) : undefined}
          ready={portfolioReady && perfReady}
          totalWithCash={totalWithCash}
          investments={investments}
          cash={cashBalance}
          invested={invested}
          pnlAbs={pnlAbs}
          pnlPct={pnlPct}
          history={history}
        />

        {/* Row 1 — gauge · allocation · jade agent card */}
        <motion.div variants={gridStagger} className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          <RiskCard portfolio={portfolio} ready={portfolioReady} />
          {holdings.length > 0 ? (
            <AllocationCard holdings={holdings} investments={investments} />
          ) : (
            <DashCard><p className="font-sans text-[13px] text-ink-faint">No holdings yet.</p></DashCard>
          )}
          <div className="md:col-span-2 lg:col-span-1 flex">
            <AskAsaasCard holdings={holdings} cash={cashBalance} />
          </div>
        </motion.div>

        {/* Row 2 — performance (2 cols) · upcoming events */}
        <motion.div variants={gridStagger} className="grid gap-5 lg:grid-cols-3">
          <PerformanceCard history={history} ready={perfReady} range={range} onRange={setRange} />
          <EventsCard events={events} ready={eventsQ.status !== 'pending'} />
        </motion.div>

        {/* Row 3 — holdings + activity (2 cols) · alerts & news + wallet */}
        <motion.div variants={gridStagger} className="grid gap-5 lg:grid-cols-3 items-start">
          <div className="lg:col-span-2 flex flex-col gap-5 min-w-0">
            {holdings.length > 0 && <HoldingsCard holdings={holdings} perf={perf} events={events} />}
            {holdings.length > 0 && <MyActivity holdings={holdings} onChanged={refresh} />}
          </div>
          <div className="flex flex-col gap-5 min-w-0">
            <FeedCard
              flags={flags}
              flagsReady={flagsQ.status !== 'pending'}
              news={news}
              newsReady={newsQ.status !== 'pending'}
            />
            <DashCard className="p-0 border-0 bg-transparent shadow-none">
              <WalletCard />
            </DashCard>
          </div>
        </motion.div>

        {/* Row 4 — monthly value bars (2 cols) · market sentiment */}
        <motion.div variants={gridStagger} className="grid gap-5 lg:grid-cols-3 items-start">
          <MonthlyValueCard history={history} ready={perfReady} />
          <DashCard className="p-0 border-0 bg-transparent shadow-none">
            <MarketSentimentGauge />
          </DashCard>
        </motion.div>

        {/* Row 5 — risk analytics as a full-width tile grid */}
        <DashCard className="p-0 border-0 bg-transparent shadow-none">
          <RiskPanel variant="grid" />
        </DashCard>
      </motion.div>
    </MotionConfig>
  )
}
