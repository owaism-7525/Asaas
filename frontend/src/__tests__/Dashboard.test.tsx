import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import type { PortfolioResponse, PerformanceResponse, NewsItemResponse, FlagResponse } from '@/types/api'

// Dashboard reads through the shared TanStack Query cache; re-import it (and
// the query client + provider) fresh per test via resetModules so cached data
// never leaks between tests (e.g. a cached portfolio masking an error test).
let Dashboard: (typeof import('@/pages/Dashboard'))['default']
let renderDash: () => ReturnType<typeof render>

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}))

// Dashboard gates its data load on `!authLoading`; the real AuthContext defaults
// to loading:true (no provider in tests), which would block every fetch. Mock a
// settled, signed-in session so the dashboard actually loads.
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', email: 'test@test.com' }, loading: false, signOut: vi.fn() }),
}))

vi.mock('@/context/ThemeContext', () => ({
  useTheme: () => ({ theme: 'light', toggleTheme: vi.fn() }),
}))

vi.mock('react-chartjs-2', () => ({
  Bar: () => <div data-testid="monthly-bars" />,
  Line: () => <div />,
  Doughnut: () => <div />,
}))

vi.mock('@/components/charts/PerformanceLine', () => ({
  PerformanceLine: () => <div data-testid="performance-line" />,
}))

vi.mock('@/components/charts/AllocationDonut', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/charts/AllocationDonut')>()),
  AllocationDonut: () => <div data-testid="allocation-donut" />,
}))

vi.mock('@/components/charts/Sparkline', () => ({
  Sparkline: () => <div data-testid="sparkline" />,
}))

vi.mock('@/components/layout/FlagCard', () => ({
  FlagCard: ({ flag }: { flag: FlagResponse }) => (
    <div data-testid="flag-card">{flag.message}</div>
  ),
}))

vi.mock('@/components/layout/DashboardChatComposer', () => ({
  DashboardChatComposer: () => <div data-testid="chat-composer" />,
}))

const mockGetPortfolio = vi.fn()
const mockGetPerformance = vi.fn()
const mockGetNewsFeed = vi.fn()
const mockGetFlags = vi.fn()
const mockGetRecommendation = vi.fn()

vi.mock('@/lib/api', () => ({
  getPortfolio: (...args: unknown[]) => mockGetPortfolio(...args),
  getPerformance: (...args: unknown[]) => mockGetPerformance(...args),
  getNewsFeed: (...args: unknown[]) => mockGetNewsFeed(...args),
  getFlags: (...args: unknown[]) => mockGetFlags(...args),
  getRecommendation: (...args: unknown[]) => mockGetRecommendation(...args),
  // MarketSentimentGauge calls this on mount; default to an empty snapshot so
  // the gauge renders nothing and doesn't crash the Dashboard under test.
  getMarketSentiment: () => Promise.resolve({ as_of: null, market: null, sectors: [], asset_classes: [] }),
  getRiskMetrics: () => Promise.resolve({ insufficient_data: true }),
  getProfile: () => Promise.resolve({ risk_tolerance: 'moderate', horizon: 'medium' }),
  getWallet: () => Promise.resolve({ balance: '0' }),
  getCashTransactions: () => Promise.resolve({ items: [], total: 0 }),
  getEvents: () => Promise.resolve({ events: [] }),
  getHoldingHistory: () => Promise.resolve({ symbol: '', history: [] }),
}))

const basePortfolio: PortfolioResponse = {
  id: 'p1',
  user_id: 'u1',
  name: 'My Portfolio',
  status: 'confirmed',
  holdings: [
    { id: 'h1', portfolio_id: 'p1', instrument_id: 'i1', symbol: 'HBL.KA', name: 'HBL', weight: 0.4, target_weight: 0.4, asset_class: 'psx_stock' },
    { id: 'h2', portfolio_id: 'p1', instrument_id: 'i2', symbol: 'OGDC.KA', name: 'OGDC', weight: 0.3, target_weight: 0.3, asset_class: 'psx_stock' },
    { id: 'h3', portfolio_id: 'p1', instrument_id: 'i3', symbol: 'BTC', name: 'Bitcoin', weight: 0.3, target_weight: 0.3, asset_class: 'crypto' },
  ],
  expected_return: '0.12',
  expected_risk: '0.18',
  sharpe: '1.35',
  risk_free_rate: '0.11',
  created_at: '2025-01-01T00:00:00Z',
}

const basePerf: PerformanceResponse = {
  pnl_absolute: '50000',
  pnl_percent: '0.05',
  history: [
    { date: '2025-01-01', value: '1000000' },
    { date: '2025-06-01', value: '1050000' },
  ],
}

const baseNews: NewsItemResponse[] = [
  {
    id: 'n1', headline: 'SBP keeps rate unchanged', source: 'SBP',
    impact: 'positive', impact_level: 'macro', materiality_score: 0.8,
    published_at: '2025-06-01T00:00:00Z', url: 'https://example.com',
  },
  {
    id: 'n2', headline: 'PSX hits new high', source: 'PSX',
    impact: 'positive', impact_level: 'sector', materiality_score: 0.6,
    published_at: '2025-06-01T00:00:00Z', url: 'https://example.com',
  },
]

const baseFlags: FlagResponse[] = [
  {
    id: 'f1', portfolio_id: 'p1', type: 'news', category: 'news',
    severity: 'high', message: 'Rate decision pending', status: 'pending',
    created_at: '2025-06-01T00:00:00Z', dismissed: false,
  },
  {
    id: 'f2', portfolio_id: 'p1', type: 'news', category: 'news',
    severity: 'medium', message: 'Old alert', status: 'acknowledged',
    created_at: '2025-05-01T00:00:00Z', dismissed: true,
  },
]

beforeEach(async () => {
  vi.clearAllMocks()
  vi.resetModules()  // drop Dashboard's module-level cache between tests
  mockGetPortfolio.mockResolvedValue(basePortfolio)
  mockGetPerformance.mockResolvedValue(basePerf)
  mockGetNewsFeed.mockResolvedValue(baseNews)
  mockGetFlags.mockResolvedValue(baseFlags)
  mockGetRecommendation.mockRejectedValue(new Error('no recommendation'))
  Dashboard = (await import('@/pages/Dashboard')).default
  const { QueryClientProvider } = await import('@tanstack/react-query')
  const { queryClient } = await import('@/lib/queries')
  queryClient.setDefaultOptions({ queries: { retry: false } })  // surface errors immediately
  renderDash = () => render(
    <QueryClientProvider client={queryClient}><Dashboard /></QueryClientProvider>,
  )
})

describe('Dashboard', () => {
  it('shows loading skeleton initially', () => {
    mockGetPortfolio.mockReturnValue(new Promise(() => {}))
    renderDash()
    const skeletons = document.querySelectorAll('.skeleton')
    expect(skeletons.length).toBeGreaterThan(0)
  })

  it('renders portfolio name when portfolio exists', async () => {
    renderDash()
    await waitFor(() => {
      expect(screen.getByText('My Portfolio')).toBeInTheDocument()
    })
  })

  it('renders holdings count when portfolio has no name', async () => {
    mockGetPortfolio.mockResolvedValue({ ...basePortfolio, name: null })
    renderDash()
    await waitFor(() => {
      expect(screen.getByText('3 holdings')).toBeInTheDocument()
    })
  })

  it('renders a retry state (not the build prompt) when portfolio fetch fails transiently', async () => {
    // A generic error has no .status, so it's treated as transient (500/network),
    // NOT a genuine 404 — the portfolio may still exist, so don't show "build first".
    mockGetPortfolio.mockRejectedValue(new Error('network'))
    renderDash()
    await waitFor(() => {
      expect(screen.getByText(/Couldn't load your portfolio/)).toBeInTheDocument()
    })
    expect(screen.queryByText(/No portfolio yet/)).not.toBeInTheDocument()
  })

  it('renders risk score using expected_risk', async () => {
    renderDash()
    await waitFor(() => {
      expect(screen.getByText('18')).toBeInTheDocument()
    })
    expect(screen.getByText('/ 100')).toBeInTheDocument()
  })

  it('renders performance chart when history exists', async () => {
    renderDash()
    await waitFor(() => {
      expect(screen.getByTestId('performance-line')).toBeInTheDocument()
    })
  })

  it('renders "No performance data" when history is empty', async () => {
    mockGetPerformance.mockResolvedValue({ pnl_absolute: '0', pnl_percent: '0', history: [] })
    renderDash()
    await waitFor(() => {
      expect(screen.getByText('No performance data yet')).toBeInTheDocument()
    })
  })

  it('renders P&L stats correctly', async () => {
    renderDash()
    await waitFor(() => {
      // Whole rupees everywhere (₨ is a separate mono span, so match the digits).
      // Total gain (and the change since the prior snapshot) are both +₨50,000 here.
      expect(screen.getAllByText('50,000').length).toBeGreaterThanOrEqual(1)
    })
    expect(screen.getAllByText('+5.00%').length).toBeGreaterThanOrEqual(1)
  })

  it('renders expected return and Sharpe', async () => {
    renderDash()
    await waitFor(() => {
      expect(screen.getByText('12.0%')).toBeInTheDocument()
    })
    expect(screen.getByText('1.35')).toBeInTheDocument()
  })

  it('renders SBP rate from risk_free_rate as a percent', async () => {
    // risk_free_rate is a fraction (0.11) → must render as 11.00%, not 0.11%.
    renderDash()
    await waitFor(() => {
      expect(screen.getByText('SBP rate')).toBeInTheDocument()
      expect(screen.getByText('11.00%')).toBeInTheDocument()
    })
  })

  it('renders holdings list with weights', async () => {
    renderDash()
    await waitFor(() => {
      expect(screen.getByText('HBL.KA')).toBeInTheDocument()
    })
    expect(screen.getAllByText('HBL').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('40.0%').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('OGDC.KA')).toBeInTheDocument()
    expect(screen.getByText('BTC')).toBeInTheDocument()
  })

  it('renders only active (non-dismissed) flags', async () => {
    renderDash()
    await waitFor(() => {
      expect(screen.getByText('Rate decision pending')).toBeInTheDocument()
    })
    expect(screen.queryByText('Old alert')).not.toBeInTheDocument()
  })

  it('renders "All clear" when no active flags', async () => {
    mockGetFlags.mockResolvedValue([])
    renderDash()
    await waitFor(() => {
      expect(screen.getByText(/All clear/)).toBeInTheDocument()
    })
  })

  it('renders news items with impact badges', async () => {
    renderDash()
    await waitFor(() => {
      expect(screen.getByText('SBP keeps rate unchanged')).toBeInTheDocument()
    })
    expect(screen.getByText('PSX hits new high')).toBeInTheDocument()
    // Impact is shown as an arrow badge (labelled for screen readers) + level.
    expect(screen.getAllByLabelText('positive').length).toBe(2)
    expect(screen.getByText('· macro')).toBeInTheDocument()
  })

  it('renders allocation donut when holdings exist', async () => {
    renderDash()
    await waitFor(() => {
      expect(screen.getByTestId('allocation-donut')).toBeInTheDocument()
    })
  })

  it('handles portfolio API error gracefully', async () => {
    mockGetPortfolio.mockRejectedValue(new Error('network'))
    renderDash()
    await waitFor(() => {
      expect(screen.getByText(/Couldn't load your portfolio/)).toBeInTheDocument()
    })
  })

  it('handles all API errors gracefully', async () => {
    mockGetPortfolio.mockRejectedValue(new Error('fail'))
    mockGetPerformance.mockRejectedValue(new Error('fail'))
    mockGetNewsFeed.mockRejectedValue(new Error('fail'))
    mockGetFlags.mockRejectedValue(new Error('fail'))
    renderDash()
    await waitFor(() => {
      expect(screen.getByText(/Couldn't load your portfolio/)).toBeInTheDocument()
    })
  })
})
