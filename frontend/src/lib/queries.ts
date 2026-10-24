/**
 * Shared server-state cache (TanStack Query).
 *
 * Every page reads portfolio / profile / wallet / news / flags through these
 * hooks, so data one page loaded is shown instantly on the next and refreshed
 * in the background once it is older than `staleTime`. Mutations invalidate
 * the affected keys instead of each page re-fetching by hand.
 */

import { QueryClient, useQuery, type QueryClient as QC } from '@tanstack/react-query'
import { useEffect } from 'react'
import {
  getPortfolio,
  getProfile,
  getPerformance,
  getNewsFeed,
  getFlags,
  getWallet,
  getCashTransactions,
  getRiskMetrics,
  getMarketSentiment,
  getTicker,
  getWatchlist,
  getDiversification,
  getEvents,
  getHoldingHistory,
} from '@/lib/api'
import type { FlagResponse } from '@/types/api'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,          // reuse for 1 min, then refresh in the background on next use
      gcTime: 30 * 60_000,        // keep unused data 30 min for instant back-navigation
      refetchOnWindowFocus: false,
      // 4xx is an answer (404 = no portfolio yet), not a blip — never retry it.
      retry: (failureCount, error) => {
        const status = (error as { status?: number })?.status
        if (status !== undefined && status >= 400 && status < 500) return false
        return failureCount < 1
      },
    },
  },
})

export const qk = {
  portfolio: ['portfolio'] as const,
  profile: ['profile'] as const,
  performance: ['performance'] as const,
  news: ['news'] as const,
  flags: ['flags'] as const,
  wallet: ['wallet'] as const,
  cashTx: ['cashTx'] as const,
  risk: ['risk'] as const,
  sentiment: ['sentiment'] as const,
  ticker: ['ticker'] as const,
  watchlist: ['watchlist'] as const,
  diversification: ['diversification'] as const,
  events: ['events'] as const,
  holdingHistory: ['holdingHistory'] as const,
}

type Opts = { enabled?: boolean }

export const usePortfolio = (o: Opts = {}) =>
  useQuery({ queryKey: qk.portfolio, queryFn: getPortfolio, ...o })

export const useProfile = (o: Opts = {}) =>
  useQuery({ queryKey: qk.profile, queryFn: getProfile, ...o })

export const useNewsFeed = (o: Opts = {}) =>
  useQuery({ queryKey: qk.news, queryFn: getNewsFeed, ...o })

export const useFlags = (o: Opts = {}) =>
  useQuery({ queryKey: qk.flags, queryFn: getFlags, ...o })

export const useWallet = (o: Opts = {}) =>
  useQuery({ queryKey: qk.wallet, queryFn: getWallet, ...o })

export const useCashTransactions = (limit = 10, o: Opts = {}) =>
  useQuery({ queryKey: [...qk.cashTx, limit], queryFn: () => getCashTransactions(limit), ...o })

export const useRiskMetrics = (o: Opts = {}) =>
  useQuery({ queryKey: qk.risk, queryFn: getRiskMetrics, ...o })

export const useMarketSentiment = (o: Opts = {}) =>
  useQuery({ queryKey: qk.sentiment, queryFn: getMarketSentiment, staleTime: 5 * 60_000, ...o })

export const useWatchlist = (o: Opts = {}) =>
  useQuery({ queryKey: qk.watchlist, queryFn: getWatchlist, ...o })

export const useDiversification = (o: Opts = {}) =>
  useQuery({ queryKey: qk.diversification, queryFn: () => getDiversification(), ...o })

/** Scraped calendars change rarely — keep for 30 min. */
export const useEvents = (o: Opts = {}) =>
  useQuery({ queryKey: qk.events, queryFn: getEvents, staleTime: 30 * 60_000, ...o })

export const useHoldingHistory = (symbol: string | undefined, o: Opts = {}) =>
  useQuery({
    queryKey: [...qk.holdingHistory, symbol],
    queryFn: () => getHoldingHistory(symbol!),
    staleTime: 5 * 60_000,
    ...o,
    enabled: !!symbol && (o.enabled ?? true),
  })

/** Ticker refreshes every 60 s; TanStack pauses the interval while the tab is hidden. */
export const useTicker = () =>
  useQuery({ queryKey: qk.ticker, queryFn: getTicker, refetchInterval: 60_000, staleTime: 30_000 })

/**
 * Performance with stale-while-revalidate: the snapshot fast path (`stale`)
 * lacks per-holding figures, so once it lands the live version is fetched and
 * swapped into the cache.
 */
export function usePerformance(o: Opts = {}) {
  const q = useQuery({ queryKey: qk.performance, queryFn: () => getPerformance(), ...o })
  const stale = q.data?.stale === true
  useEffect(() => {
    if (!stale) return
    let cancelled = false
    getPerformance({ live: true })
      .then((live) => { if (!cancelled) queryClient.setQueryData(qk.performance, live) })
      .catch(() => { /* keep the stale snapshot values */ })
    return () => { cancelled = true }
  }, [stale])
  return q
}

/** After a buy / sell / edit: everything derived from holdings or cash. */
export function invalidateHoldings(qc: QC = queryClient) {
  return Promise.all(
    [qk.portfolio, qk.performance, qk.wallet, qk.cashTx, qk.risk, qk.diversification, qk.events, qk.holdingHistory].map((queryKey) =>
      qc.invalidateQueries({ queryKey }),
    ),
  )
}

/** After a deposit / withdrawal: only cash moved. */
export function invalidateCash(qc: QC = queryClient) {
  return Promise.all([qk.wallet, qk.cashTx].map((queryKey) => qc.invalidateQueries({ queryKey })))
}

/** FlagCard already called the API — just mark the flag dismissed in the cache
 *  (Dashboard, Alerts page and the nav badge all read it). */
export function markFlagDismissed(id: string, qc: QC = queryClient) {
  qc.setQueryData<FlagResponse[]>(qk.flags, (prev) =>
    prev?.map((f) => (f.id === id ? { ...f, dismissed: true } : f)),
  )
}
