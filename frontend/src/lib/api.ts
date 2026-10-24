import { supabase } from './supabase'
import type {
  UserResponse,
  ProfileResponse,
  PortfolioResponse,
  PortfolioRecommendationResponse,
  HoldingResponse,
  NewsItemResponse,
  FlagResponse,
  ValuationResponse,
  TechnicalResponse,
  ChatHistoryItem,
  QuestionDefinition,
  QuestionnaireResponse,
  PerformanceResponse,
  DiversificationResponse,
  GuestAnalyzeResponse,
  InstrumentSearchResult,
  DeclareHoldingInput,
  NewsScrapeStatus,
  MarketSentimentResponse,
  RiskMetricsResponse,
  Conversation,
  ConversationMessage,
  WalletResponse,
  TransactionListResponse,
} from '@/types/api'
import type { SSEEvent } from '@/types/chat'

const BASE = import.meta.env.VITE_API_URL as string

async function authHeaders(): Promise<Record<string, string>> {
  let { data } = await supabase.auth.getSession()
  // Refresh proactively if token is expired or expires within 60 s
  const exp = data.session?.expires_at ?? 0
  if (data.session && exp - Date.now() / 1000 < 60) {
    const refreshed = await supabase.auth.refreshSession()
    if (refreshed.data.session) data = refreshed.data
  }
  const token = data.session?.access_token
  if (!token) {
    throw new ApiError('Session expired. Please log in again.', 401)
  }
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
}

class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

/*
 * Local-user registration is a prerequisite for every protected endpoint:
 * the backend issues 401 "User not found" until POST /auth/session upserts
 * the row from the verified Supabase JWT. AuthContext fires this on sign-in,
 * but pages can race ahead of it. ensureLocalUser() registers on demand and
 * dedupes concurrent callers so we never stampede /auth/session.
 */
let sessionPromise: Promise<void> | null = null

async function ensureLocalUser(): Promise<void> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const res = await fetch(`${BASE}/auth/session`, {
        method: 'POST',
        headers: await authHeaders(),
      })
      if (!res.ok) throw new ApiError(`POST /auth/session → ${res.status}`, res.status)
    })().finally(() => {
      sessionPromise = null
    })
  }
  return sessionPromise
}

/* Run a request; on a 401 register the local user once and retry a single time. */
async function withSessionRetry<T>(path: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (path !== '/auth/session' && err instanceof ApiError && err.status === 401) {
      await ensureLocalUser()
      return fn()
    }
    throw err
  }
}

/** Build an ApiError whose message is the backend's `detail` when present,
 *  so callers can surface real error text (e.g. "Insufficient funds: …"). */
async function toApiError(method: string, path: string, res: Response): Promise<ApiError> {
  let detail = ''
  try {
    const body = await res.json() as { detail?: unknown }
    if (body.detail) detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)
  } catch { /* non-JSON body — keep generic message */ }
  return new ApiError(detail || `${method} ${path} → ${res.status}`, res.status)
}

async function get<T>(path: string, timeoutMs = 30000): Promise<T> {
  return withSessionRetry(path, async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(`${BASE}${path}`, { headers: await authHeaders(), signal: controller.signal })
      if (!res.ok) throw await toApiError('GET', path, res)
      return res.json() as Promise<T>
    } finally {
      clearTimeout(timer)
    }
  })
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  return withSessionRetry(path, async () => {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: await authHeaders(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) throw await toApiError('POST', path, res)
    return res.json() as Promise<T>
  })
}

async function put<T>(path: string, body?: unknown): Promise<T> {
  return withSessionRetry(path, async () => {
    const res = await fetch(`${BASE}${path}`, {
      method: 'PUT',
      headers: await authHeaders(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) throw await toApiError('PUT', path, res)
    return res.json() as Promise<T>
  })
}

async function del(path: string): Promise<void> {
  return withSessionRetry(path, async () => {
    const res = await fetch(`${BASE}${path}`, {
      method: 'DELETE',
      headers: await authHeaders(),
    })
    if (!res.ok) throw await toApiError('DELETE', path, res)
  })
}

/* ------------------------------------------------------------------ */
/* Response transformers — map backend shapes to frontend types          */
/* ------------------------------------------------------------------ */

function transformHolding(raw: Record<string, unknown>): HoldingResponse {
  const tw = typeof raw.target_weight === 'number' ? raw.target_weight : parseFloat(String(raw.target_weight ?? '0'))
  const aw = typeof raw.actual_weight === 'number' ? raw.actual_weight : parseFloat(String(raw.actual_weight ?? '0'))
  return {
    ...raw,
    weight: aw || tw || 0,
  } as HoldingResponse
}

function transformPortfolio(raw: Record<string, unknown>): PortfolioResponse {
  const holdings = Array.isArray(raw.holdings) ? raw.holdings.map(transformHolding) : []
  return {
    ...raw,
    id: raw.id as string,
    expected_risk: String(raw.expected_risk ?? raw.risk ?? '0'),
    holdings,
  } as PortfolioResponse
}

function transformFlag(raw: Record<string, unknown>): FlagResponse {
  return {
    ...raw,
    category: raw.type as string,
    dismissed: raw.status !== 'pending',
  } as FlagResponse
}

function transformNews(raw: Record<string, unknown>): NewsItemResponse {
  return {
    ...raw,
    impact: (raw.impact ?? 'neutral') as 'positive' | 'negative' | 'neutral',
    impact_level: (raw.impact_level ?? 'macro') as 'direct' | 'sector' | 'macro',
  } as NewsItemResponse
}

/* ------------------------------------------------------------------ */
/* Chat streaming                                                       */
/* ------------------------------------------------------------------ */
export async function streamChat(
  message: string,
  handlers: {
    onTool?: (tool: string, status: 'running' | 'done') => void
    onContent?: (delta: string) => void
    onDone?: (agentRole: string) => void
  },
  signal?: AbortSignal,
  conversationId?: string,
): Promise<void> {
  const headers = await authHeaders()
  const res = await fetch(`${BASE}/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ message, conversation_id: conversationId }),
    signal,
  })

  if (!res.ok || !res.body) throw new Error(`/chat → ${res.status}`)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const processChunk = (chunk: string) => {
    if (!chunk.startsWith('data:')) return
    const raw = chunk.slice('data:'.length).trim()
    if (!raw) return

    let evt: SSEEvent
    try {
      evt = JSON.parse(raw) as SSEEvent
    } catch {
      return
    }

    if (evt.event === 'tool') {
      handlers.onTool?.(evt.tool, evt.status)
    } else if (evt.event === 'content') {
      handlers.onContent?.(evt.delta)
    } else if (evt.event === 'done') {
      handlers.onDone?.(evt.agentRole)
    } else if (evt.event === 'error') {
      throw new Error(evt.message ?? 'Stream error')
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      // Flush any trailing frame: the final 'done' event may arrive without a
      // closing '\n\n', which would otherwise leave it unparsed in the buffer
      // and the message stuck in its streaming (plain-text) render state.
      if (buffer.trim()) processChunk(buffer.trim())
      break
    }
    buffer += decoder.decode(value, { stream: true })

    const chunks = buffer.split('\n\n')
    buffer = chunks.pop() ?? ''

    for (const chunk of chunks) processChunk(chunk)
  }
}

/* ------------------------------------------------------------------ */
/* Chat history                                                         */
/* ------------------------------------------------------------------ */
export function getChatHistory(): Promise<ChatHistoryItem[]> {
  return get<Record<string, unknown>[]>('/chat/history').then((items) =>
    items.map((item) => ({
      id: item.id as string,
      role: item.role as 'user' | 'assistant',
      content: item.content as string,
      tool_calls: item.tool_calls as Record<string, unknown> | undefined,
      agent_role: item.role === 'assistant' ? ((item.agent_role as string) ?? 'chat') : undefined,
      created_at: item.created_at as string,
    })),
  )
}

/* ------------------------------------------------------------------ */
/* Raabta AI — conversations                                            */
/* ------------------------------------------------------------------ */
export function getConversations(): Promise<Conversation[]> {
  return get<Conversation[]>('/chat/conversations')
}

export function createConversation(): Promise<Conversation> {
  return post<Conversation>('/chat/conversations')
}

export function getConversationMessages(id: string): Promise<ConversationMessage[]> {
  return get<ConversationMessage[]>(`/chat/conversations/${id}`)
}

export function deleteConversation(id: string): Promise<void> {
  return del(`/chat/conversations/${id}`)
}

/* ------------------------------------------------------------------ */
/* Profile                                                              */
/* ------------------------------------------------------------------ */
export function getProfile(): Promise<ProfileResponse> {
  return get<ProfileResponse>('/profile')
}

export async function putProfile(data: Partial<ProfileResponse>): Promise<ProfileResponse> {
  const res = await fetch(`${BASE}/profile`, {
    method: 'PUT',
    headers: await authHeaders(),
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error(`PUT /profile → ${res.status}`)
  return res.json() as Promise<ProfileResponse>
}

/* ------------------------------------------------------------------ */
/* Portfolio                                                            */
/* ------------------------------------------------------------------ */
export function getPortfolio(): Promise<PortfolioResponse> {
  return get<Record<string, unknown>>('/portfolio').then(transformPortfolio)
}

export function postSuggest(): Promise<PortfolioResponse> {
  return post<Record<string, unknown>>('/portfolio/suggest').then(transformPortfolio)
}

export interface DashboardEvent {
  date: string                       // ISO yyyy-mm-dd
  type: 'mpc' | 'maturity' | 'coupon'
  title: string
  detail: string
  symbol: string | null
}

/** Upcoming SBP MPC meetings + maturities / coupons of held debt (next 120 days). */
export function getEvents(): Promise<{ events: DashboardEvent[] }> {
  return get('/portfolio/events')
}

export function getHoldingHistory(
  symbol: string,
): Promise<{ symbol: string; history: { date: string; value: string }[] }> {
  return get(`/portfolio/holdings/${encodeURIComponent(symbol)}/history`)
}

export function postConfirm(holdings: HoldingResponse[]): Promise<PortfolioResponse> {
  return post<Record<string, unknown>>('/portfolio/confirm', { holdings }).then(transformPortfolio)
}

/* ------------------------------------------------------------------ */
/* News                                                                 */
/* ------------------------------------------------------------------ */
export function getNewsFeed(): Promise<NewsItemResponse[]> {
  return get<Record<string, unknown>[]>('/news/feed').then((items) => items.map(transformNews))
}

export function triggerNewsScrape(): Promise<{ status: string }> {
  return post<{ status: string }>('/news/scrape')
}

export function getScrapeStatus(): Promise<NewsScrapeStatus> {
  return get<NewsScrapeStatus>('/news/scrape/status')
}

export function getMarketSentiment(): Promise<MarketSentimentResponse> {
  return get<MarketSentimentResponse>('/news/sentiment')
}

export function getRiskMetrics(): Promise<RiskMetricsResponse> {
  return get<RiskMetricsResponse>('/portfolio/risk')
}

/* ------------------------------------------------------------------ */
/* Flags                                                                */
/* ------------------------------------------------------------------ */
export function getFlags(): Promise<FlagResponse[]> {
  return get<Record<string, unknown>[]>('/flags').then((flags) => flags.map(transformFlag))
}

export function dismissFlag(id: string): Promise<void> {
  return post<void>(`/flags/${id}/dismiss`)
}

/* ------------------------------------------------------------------ */
/* Analysis                                                             */
/* ------------------------------------------------------------------ */
export function getCompanyInfo(symbol: string) {
  return get<ValuationResponse['company_info']>(`/analysis/company/${symbol}`)
}

export function postValuation(
  symbol: string,
  opts?: {
    assumptions?: Record<string, unknown>
    peers?: string[]
    asset_class?: string
    face_value?: string | number
    coupon_rate?: string | number
    buy_date?: string
  },
): Promise<ValuationResponse> {
  const { asset_class, face_value, coupon_rate, buy_date, ...body } = opts ?? {}
  const params = new URLSearchParams()
  if (asset_class) params.set('asset_class', asset_class)
  if (face_value != null) params.set('face_value', String(face_value))
  if (coupon_rate != null) params.set('coupon_rate', String(coupon_rate))
  if (buy_date) params.set('buy_date', buy_date)
  const qs = params.toString() ? `?${params.toString()}` : ''
  return post<ValuationResponse>(`/analysis/valuation/${symbol}${qs}`, body)
}

/** Map the backend technical payload (rsi_14, macd_line, support_levels[], …,
 *  all strings) to the frontend TechnicalResponse shape (rsi, macd, support, …
 *  as numbers). Without this the card reads undefined keys and renders blank. */
function transformTechnical(raw: Record<string, unknown>): TechnicalResponse {
  const n = (v: unknown): number | undefined => {
    if (v == null) return undefined
    const f = parseFloat(String(v))
    return Number.isFinite(f) ? f : undefined
  }
  const arr = (v: unknown): number[] => (Array.isArray(v) ? v.map((x) => parseFloat(String(x))).filter(Number.isFinite) : [])
  if (raw.disabled || raw.insufficient_data) {
    return raw as unknown as TechnicalResponse
  }
  const support = arr(raw.support_levels)
  const resistance = arr(raw.resistance_levels)
  return {
    symbol: String(raw.symbol ?? ''),
    rsi: n(raw.rsi_14),
    rsi_overbought: n(raw.rsi_overbought),
    rsi_oversold: n(raw.rsi_oversold),
    macd: n(raw.macd_line),
    macd_signal: n(raw.macd_signal),
    macd_hist: n(raw.macd_histogram),
    mfi: n(raw.mfi_14),
    sma_20: n(raw.sma_20),
    sma_50: n(raw.sma_50),
    sma_200: n(raw.sma_200),
    ema_20: n(raw.ema_20),
    ema_50: n(raw.ema_50),
    support: support.length ? support[support.length - 1] : undefined, // nearest support below
    resistance: resistance.length ? resistance[0] : undefined,         // nearest resistance above
    crossover: (raw.crossover === 'golden_cross' || raw.crossover === 'death_cross') ? raw.crossover : null,
  }
}

export function getTechnical(symbol: string, assetClass?: string): Promise<TechnicalResponse> {
  const qs = assetClass ? `?asset_class=${encodeURIComponent(assetClass)}` : ''
  return get<Record<string, unknown>>(`/analysis/technical/${symbol}${qs}`).then(transformTechnical)
}

/** Live PSX debt-market record for a single instrument (security_code or tenor key). */
export function getDebtInstrument(symbol: string): Promise<DebtInstrument> {
  return get<DebtInstrument>(`/market/debt/${encodeURIComponent(symbol)}`)
}

/* ------------------------------------------------------------------ */
/* Auth                                                                 */
/* ------------------------------------------------------------------ */
export async function postSession(): Promise<UserResponse> {
  return post<UserResponse>('/auth/session')
}

export function getMe(): Promise<UserResponse> {
  return get<UserResponse>('/auth/me')
}

/* ------------------------------------------------------------------ */
/* Questionnaire / onboarding                                          */
/* ------------------------------------------------------------------ */
export async function getQuestions(): Promise<QuestionDefinition[]> {
  const res = await fetch(`${BASE}/profile/questionnaire`, {
    headers: { 'Content-Type': 'application/json' },
  })
  if (!res.ok) throw new Error(`GET /profile/questionnaire → ${res.status}`)
  return res.json()
}

export function postQuestionnaire(
  answers: { question_id: string; answer: string | string[] | number }[],
  initialCapital: string,
  monthlyContribution: string,
  investmentFrequency: string,
  investmentPreferences?: Record<string, unknown>,
): Promise<QuestionnaireResponse> {
  return post<QuestionnaireResponse>('/profile/questionnaire', {
    answers,
    initial_capital: initialCapital,
    monthly_contribution: monthlyContribution || '0',
    investment_frequency: investmentFrequency || 'one_time',
    investment_preferences: investmentPreferences ?? null,
  })
}

/* ------------------------------------------------------------------ */
/* Portfolio activity — buy / sell / update holdings                    */
/* ------------------------------------------------------------------ */
export function addHolding(body: {
  symbol: string; quantity: string; entry_price: string; entry_date?: string
  asset_class?: string; name?: string  // picker hint — registers unseeded non-PSX symbols
}): Promise<PortfolioResponse> {
  return post<Record<string, unknown>>('/portfolio/holdings/add', body).then(transformPortfolio)
}

export function sellHolding(body: {
  holding_id: string; quantity: string; price: string; date?: string
}): Promise<PortfolioResponse> {
  return post<Record<string, unknown>>('/portfolio/holdings/sell', body).then(transformPortfolio)
}

export function updateHolding(holdingId: string, body: { entry_price: string }): Promise<PortfolioResponse> {
  return put<Record<string, unknown>>(`/portfolio/holdings/${holdingId}`, body).then(transformPortfolio)
}

export function declareHoldings(holdings: DeclareHoldingInput[]): Promise<PortfolioResponse> {
  return post<PortfolioResponse>('/portfolio/declare-holdings', { holdings })
}

/* ------------------------------------------------------------------ */
/* Portfolio extras                                                     */
/* ------------------------------------------------------------------ */
export function getRecommendation(): Promise<PortfolioRecommendationResponse> {
  return get<PortfolioRecommendationResponse>('/profile/recommendation')
}

export function getPerformance(opts?: { live?: boolean }): Promise<PerformanceResponse> {
  const qs = opts?.live ? '?live=true' : ''
  return get<PerformanceResponse>(`/portfolio/performance${qs}`)
}

export function getDiversification(portfolioId?: string): Promise<DiversificationResponse> {
  const qs = portfolioId ? `?portfolio_id=${portfolioId}` : ''
  return get<DiversificationResponse>(`/portfolio/analyze${qs}`)
}

export function reoptimize(flagId?: string): Promise<PortfolioResponse> {
  const qs = flagId ? `?flag_id=${flagId}` : ''
  return post<Record<string, unknown>>(`/portfolio/reoptimize${qs}`).then(transformPortfolio)
}

/* ------------------------------------------------------------------ */
/* Wallet — virtual PKR cash                                            */
/* ------------------------------------------------------------------ */
export function getWallet(): Promise<WalletResponse> {
  return get<WalletResponse>('/wallet')
}

export function depositCash(amount: string, note?: string): Promise<WalletResponse> {
  return post<WalletResponse>('/wallet/deposit', { amount, note })
}

export function withdrawCash(amount: string, note?: string): Promise<WalletResponse> {
  return post<WalletResponse>('/wallet/withdraw', { amount, note })
}

export function getCashTransactions(limit = 50, offset = 0): Promise<TransactionListResponse> {
  return get<TransactionListResponse>(`/wallet/transactions?limit=${limit}&offset=${offset}`)
}

/* ------------------------------------------------------------------ */
/* Guest                                                                */
/* ------------------------------------------------------------------ */
export async function analyzeGuest(
  holdings: import('@/types/api').GuestHoldingPayload[],
): Promise<GuestAnalyzeResponse> {
  const url = `${BASE}/portfolio/analyze-guest`
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ holdings }),
    })
  } catch (netErr) {
    throw Object.assign(
      new Error(`Cannot reach server at ${url}. Is the backend running?`),
      { status: 0 },
    )
  }
  if (!res.ok) {
    let detail = ''
    try {
      const body = await res.json() as { detail?: unknown }
      if (body.detail) detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)
    } catch { /* ignore parse error */ }
    throw Object.assign(new Error(`analyze-guest → ${res.status}${detail ? ': ' + detail : ''}`), { status: res.status })
  }
  const raw = await res.json() as Record<string, unknown>
  return {
    ...raw,
    suggested_portfolio: transformPortfolio(raw.suggested_portfolio as Record<string, unknown>),
  } as GuestAnalyzeResponse
}

/* ------------------------------------------------------------------ */
/* Market search                                                        */
/* ------------------------------------------------------------------ */
export async function searchMarket(q: string): Promise<InstrumentSearchResult[]> {
  const res = await fetch(`${BASE}/market/search?query=${encodeURIComponent(q)}`, {
    headers: { 'Content-Type': 'application/json' },
  })
  if (!res.ok) throw new Error(`GET /market/search → ${res.status}`)
  return res.json()
}

/* ------------------------------------------------------------------ */
/* Market ticker                                                        */
/* ------------------------------------------------------------------ */
export interface TickerItem {
  symbol: string
  name: string
  price: string
  currency: string
  asset_class: string
  change: number | null
  change_pct: number | null
  price_date: string
  source: string
}

export interface TickerResponse {
  items: TickerItem[]
  as_of: string | null
  stale: boolean
}

export function getTicker(): Promise<TickerResponse> {
  return get<TickerResponse>('/market/ticker')
}

/* ------------------------------------------------------------------ */
/* Debt market                                                          */
/* ------------------------------------------------------------------ */
export interface DebtInstrument {
  security_code: string
  security_name: string
  face_value: number | null
  listing_date: string
  issue_date: string
  issue_size: number | null
  maturity_date: string
  coupon_rate: number | null
  prev_coupon_date: string
  next_coupon_date: string
  outstanding_days: number | null
  remaining_years: number | null
  category: string
}

export interface DebtMarketResponse {
  items: DebtInstrument[]
  as_of: string | null
  stale: boolean
  count: number
}

export function getDebtMarket(): Promise<DebtMarketResponse> {
  return get<DebtMarketResponse>('/market/debt-market')
}

/* ------------------------------------------------------------------ */
/* Watchlist — stocks / commodities / debt / crypto                     */
/* ------------------------------------------------------------------ */
import type { WatchlistItem, WatchlistResponse } from '@/types/api'

export function getWatchlist(): Promise<WatchlistResponse> {
  return get<WatchlistResponse>('/watchlist')
}

export function addToWatchlist(symbol: string, assetClass?: string, name?: string): Promise<WatchlistItem> {
  return post<WatchlistItem>('/watchlist', { symbol, asset_class: assetClass, name })
}

export function removeFromWatchlist(id: string): Promise<void> {
  return del(`/watchlist/${id}`)
}

/* ------------------------------------------------------------------ */
/* Market quote — PKR price for the buy form's auto-fill                */
/* ------------------------------------------------------------------ */
import type { QuoteResponse } from '@/types/api'

export function getQuote(symbol: string): Promise<QuoteResponse> {
  return get<QuoteResponse>(`/market/quote/${encodeURIComponent(symbol)}`)
}
