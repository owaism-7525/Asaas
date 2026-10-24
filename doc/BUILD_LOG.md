# BUILD_LOG.md — Asaas (اثاثہ)

**Single source of truth for the build's current state.**

This file records every file in the project: what it is, what it does, and how it has changed. It must be updated in the same change as any file creation, edit, or deletion (see `RULES.md` A2.8). Anyone — human or AI — should be able to read this one file and understand the whole build without opening every other file.

---

## How to maintain this file

**On every change, do all of the following:**

1. **File registry (§1)** — add a row when a file is created; update its "Purpose" when its role changes; mark it `removed` and move it to §3 when deleted.
2. **Change history (§2)** — append one dated entry describing what changed and why. Newest at the top.
3. **Current state summary (§4)** — refresh the snapshot when a phase milestone is reached.

Keep entries short and factual. This is a log, not prose. A change is not done until this log reflects it.

**Status tags:** `planned` · `in progress` · `done` · `removed`

**Entry format for §2:**
```
### YYYY-MM-DD — short title
- created/edited/deleted: `path` — one line on what and why
```

---

## 1. File registry

### Specs (exist — source of truth)
| File | Status | Purpose |
|---|---|---|
| `doc/TECH.md` | done | Tech requirements + DB schema + LangGraph + LLM routing (Gemini Flash/Pro, Groq, Cerebras, OpenRouter) |
| `doc/RULES.md` | done | Coder guardrails, phased plan, security, testing, definition of done |
| `doc/AGENT_RULES.md` | done | Per-role runtime rules, LangGraph orchestration, formulas, data cadence |
| `doc/DESIGN.md` | done | Visual system: color, typography, components, charts, tokens |
| `doc/FLOW.md` | done | User flows incl. no-login guest mode (cookie + IP limited) |
| `doc/asaas-design-preview.html` | done | Rendered UI components preview |
| `doc/asaas-charts-preview.html` | done | Rendered donut + performance charts |
| `doc/BUILD_LOG.md` | done | This file — running build record |

### Root
| File | Status | Purpose |
|---|---|---|
| `README.md` | done | Entry point: what Asaas is, how to run, links to docs |
| `.env.example` | done | All API key placeholders (Gemini, Groq, Cerebras, OpenRouter, CoinGecko, FRED, Alpha Vantage) |
| `.gitignore` | done | Ignores .env, build artifacts, node_modules, .venv |
| `docker-compose.yml` | done | Redis container for local dev (PostgreSQL removed — Supabase is the DB) |

### Backend — Phase 0: Foundation
| Area | Status | Purpose |
|---|---|---|
| `backend/requirements.txt` | done | All Python dependencies incl. FastAPI, SQLAlchemy, LangGraph, PyPortfolioOpt, BeautifulSoup, dateutil, supabase; bcrypt/passlib removed |
| `backend/alembic.ini` | done | Alembic migration configuration |
| `backend/app/main.py` | done | FastAPI entry point — CORS, router mounting, lifespan (Redis), health check |
| `backend/app/core/config.py` | done | Pydantic Settings — Supabase URL/keys/JWT secret; removed JWT_SECRET/bcrypt settings |
| `backend/app/core/db.py` | done | Async SQLAlchemy engine with `NullPool` for Supabase PgBouncer; `AsyncSession` factory |
| `backend/app/core/redis.py` | done | Async Redis client (used by cache + rate limiting + market utils) |
| `backend/app/core/market.py` | done | Shared market utilities: `get_usd_pkr_rate()` (yfinance, Redis 1h cache), `get_sbp_rate()` (SBP adapter, Redis 1h cache) with stale-cache fallback |
| `backend/app/core/market.py` | done | Shared `get_usd_pkr_rate()` + `get_sbp_rate()` with Redis caching; eliminates hardcoded FX/SBP values |
| `backend/app/core/security.py` | done | `verify_supabase_jwt()` + `get_current_user()` dependency — HS256 JWT verification against Supabase JWT secret |
| `backend/app/models/` | done | 11 ORM tables: `users` (no password_hash, no auto-uuid), `risk_profiles` (+ questionnaire_answers JSONB, evaluated_at) + 9 others |
| `backend/app/schemas/auth.py` | done | `UserResponse` only — password/token fields removed (Supabase handles auth) |
| `backend/app/schemas/profile.py` | done | `ProfileResponse` extended with `questionnaire_answers` + `evaluated_at` |
| `backend/app/schemas/questionnaire.py` | done | `QuestionDefinition`, `QuestionnaireRequest/Response`, `DeclareHoldingInput/DeclareHoldingsRequest` |
| `backend/app/schemas/` | done | Rest of schemas unchanged: user, portfolio, market, news, chat |
| `backend/app/api/auth.py` | done | GET /auth/me + POST /auth/session (upserts local user from Supabase JWT) — register/login/refresh removed |
| `backend/migrations/env.py` | done | Updated to use `database_url_sync` (direct connection) for Alembic DDL reliability |
| `backend/migrations/versions/001_supabase_migration.py` | done | Drops `password_hash`; removes UUID default from `users.id`; adds `questionnaire_answers`/`evaluated_at` to `risk_profiles`; enables RLS + creates policies on 7 tables |

### Backend — Phase 1: Data Layer
| Area | Status | Purpose |
|---|---|---|
| `backend/app/data/adapters/yfinance_adapter.py` | done | Stocks (PSX .KA + global) + commodities via yfinance; retry + async executor; `fetch_price_with_change()` for 2-day prev_close |
| `backend/app/data/adapters/coingecko_adapter.py` | done | Batched crypto prices; respects 10–50 calls/min quota |
| `backend/app/data/adapters/sbp_adapter.py` | done | SBP policy rate + T-bill yield scrape (BeautifulSoup); 3-strategy policy rate fetch, auction results page parsing, key rates fallback |
| `backend/app/data/adapters/fred_adapter.py` | done | FRED macro data; weekly refresh |
| `backend/app/data/adapters/alpha_vantage_adapter.py` | done | Commodity backup only; 25/day Redis counter enforced |
| `backend/app/data/cache.py` | done | Redis read-through: Redis → DB → adapter; TTL by asset class (crypto 60s, stocks 4h, T-bills 24h) |
| `backend/app/data/seed.py` | done | Seeds KSE-100 subset, top crypto, T-bills, gold/oil into `instruments` table |
| `backend/app/workers/daily_eod.py` | done | APScheduler job: EOD prices for all active instruments + portfolio snapshots |
| `backend/app/workers/crypto_refresh.py` | done | Interval job: CoinGecko batch fetch for held crypto |
| `backend/app/workers/tbill_watch.py` | done | Event-driven SBP scrape on policy rate announcements |
| `backend/app/api/market.py` | done | GET /market/price/{symbol}, GET /market/search |

### Backend — Phase 2: Portfolio Engine
| Area | Status | Purpose |
|---|---|---|
| `backend/app/services/optimizer.py` | done | PyPortfolioOpt wrapper — max-Sharpe with SBP risk-free rate, sector caps, heuristic fallback |
| `backend/app/services/performance.py` | done | `update_portfolio_metrics()` (P&L) + `check_and_flag_drift()` |
| `backend/app/api/profile.py` | done | GET /profile, PUT /profile, GET /profile/questionnaire (returns question set), POST /profile/questionnaire (evaluate + upsert) |
| `backend/app/api/portfolio.py` | done | POST /suggest, POST /confirm, GET /, GET /holdings, POST /reoptimize, GET /performance, POST /analyze-guest, POST /declare-holdings (onboarding), GET /analyze (diversification) |
| `backend/app/services/questionnaire.py` | done | `QUESTIONS` (5 fixed questions) + `evaluate_questionnaire()` — deterministic answer → profile field mapping |

### Backend — Phase 3: Agent & Chat
| Area | Status | Purpose |
|---|---|---|
| `backend/app/agent/types.py` | done | `AgentState` TypedDict (user_id, user_message, intent, context, portfolio_id, response, **history**) |
| `backend/app/agent/memory.py` | done | `format_history()` — renders last N chat turns as a labeled block for LLM `user_message`; "" when empty; role+content only (no tool_calls/PII) |
| `backend/app/agent/llm_router.py` | done | Task-based LLM routing — chat/light/reasoning/hard — with fallback chains across Groq, Gemini, Cerebras, OpenRouter |
| `backend/app/agent/orchestrator.py` | done | LangGraph `StateGraph`: load_context (entities + last 16 chat msgs → `history`) → classify → conditional routing → role node → END; `process_message()` public API |
| `backend/app/agent/prompts/pii_abstraction.py` | done | `ABSTRACTION_GUARDRAIL` string + `abstract_context()` + `_assert_no_pii()` (test guard) |
| `backend/app/agent/prompts/profiler_prompt.py` | done | Profiler system prompt — extracts 5 risk-profile fields; outputs JSON block when complete |
| `backend/app/agent/prompts/optimizer_prompt.py` | done | Optimizer system prompt — explains MPT allocation vs SBP rate; suggests, never advises |
| `backend/app/agent/prompts/news_prompt.py` | done | News Analyst system prompt — groups by level (direct/sector/macro), no auto-action |
| `backend/app/agent/prompts/rate_impact_prompt.py` | done | Rate-Impact system prompt — inverse yield/price relationship, Sharpe recalculation |
| `backend/app/agent/prompts/chat_prompt.py` | done | General chat prompt — front-door, Pakistan context, disclaimer footer |
| `backend/app/agent/roles/profiler.py` | done | `run_profiler()` — one LLM call, extracts JSON → calls `analyze_profile` tool |
| `backend/app/agent/roles/optimizer.py` | done | `run_optimizer()` — intent-aware: `track`→`track_value` (no new portfolio); `suggest`/`diversification`→`reoptimize` if a confirmed portfolio exists (confirmed untouched) else `suggest_portfolio`; then `check_diversification` + LLM explanation |
| `backend/app/agent/roles/news_materiality.py` | done | `run_news_analyst()` — fetches + scores news, then LLM explanation |
| `backend/app/agent/roles/rate_impact.py` | done | `run_rate_analyst()` — parses rate from message, calls `analyze_rate_impact`, then LLM |
| `backend/app/agent/roles/chat.py` | done | `run_chat()` — general conversational LLM call with abstracted context |
| `backend/app/agent/tools/analyze_profile.py` | done | Upserts `risk_profiles`; returns abstracted result (no `capital_pkr`) |
| `backend/app/agent/tools/suggest_portfolio.py` | done | Runs optimizer, writes `portfolios(draft)` + `holdings`; status always "draft" |
| `backend/app/agent/tools/check_diversification.py` | done | Sector/asset-class concentration analysis; read-only |
| `backend/app/agent/tools/confirm_holdings.py` | done | **Sole path** to `portfolio.status="confirmed"`; writes snapshot |
| `backend/app/agent/tools/track_value.py` | done | Calls `PerformanceService`; returns `pnl_percent` only — no absolute PKR |
| `backend/app/agent/tools/fetch_relevant_news.py` | done | Joins `news_holding_link` → `news_items` for portfolio instruments; read-only |
| `backend/app/agent/tools/assess_materiality.py` | done | Thin wrapper around `MaterialityService.process_news_item()` |
| `backend/app/agent/tools/flag_event.py` | done | Creates `Flag(status=pending)` — no auto-action |
| `backend/app/agent/tools/analyze_rate_impact.py` | done | Delegates to `RateImpactService.apply_policy_rate_change()` |
| `backend/app/agent/tools/reoptimize.py` | done | Ownership-checked wrapper around `suggest_portfolio`; confirmed portfolio untouched |
| `backend/app/api/chat.py` | done | POST /chat (SSE, word-by-word via real orchestrator) + GET /chat/history |

### Backend — Phase 4: News & Monitoring
| Area | Status | Purpose |
|---|---|---|
| `backend/app/services/materiality.py` | done | Matches news → instruments (direct/sector/macro), scores, creates `NewsHoldingLink` + `Flag` |
| `backend/app/services/rate_impact.py` | done | SBP rate delta → T-bill yield repricing + `Flag(type=rate_impact)` |
| `backend/app/data/news/psx_scraper.py` | done | PSX announcements — RSS primary, HTML table fallback |
| `backend/app/data/news/sbp_scraper.py` | done | SBP press releases — HTML scrape; tags rate-change headlines by keyword |
| `backend/app/data/news/business_recorder.py` | done | Business Recorder — RSS primary, HTML fallback |
| `backend/app/data/news/dawn_scraper.py` | done | Dawn business section — RSS |
| `backend/app/data/news/normalizer.py` | done | Maps raw scraper dicts → `news_items` schema; URL dedup; `dateutil` date parsing |
| `backend/app/workers/news_monitor.py` | done | Daily job — real scraper pipeline → normalize → insert → `MaterialityService` |
| `backend/app/api/news.py` | done | GET /news/feed, GET /flags, POST /flags/{id}/dismiss |

### Backend — Tests
| File | Status | Purpose |
|---|---|---|
| `backend/tests/conftest.py` | done | Pytest fixtures: test DB (configurable via TEST_DATABASE_URL), transactional session, `get_db` override; `NullPool` for Supabase compat |
| `backend/tests/test_auth.py` | done | Supabase JWT verification — valid/expired/wrong-secret/wrong-audience; /auth/session upsert; cross-user 401 |
| `backend/tests/test_onboarding.py` | done | Questionnaire question set validation; evaluate_questionnaire mapping; declared holdings entry_price as NUMERIC; diversification analysis read-only |
| `backend/tests/test_schema.py` | done | Schema integrity — FK presence, UNIQUE constraints, NUMERIC columns |
| `backend/tests/test_adapters.py` | done | Adapter smoke tests with mocked HTTP |
| `backend/tests/test_optimizer.py` | done | Weights sum to 1; sector caps; SBP risk-free rate used |
| `backend/tests/test_portfolio.py` | done | Portfolio suggest → confirm API round-trip |
| `backend/tests/test_agent.py` | done | PII abstraction assertions + no-auto-action gate (RULES.md D2.4, D2.5) |
| `backend/tests/test_tools.py` | done | Per-tool correctness; draft-only guard; money-type (no float) check |
| `backend/tests/test_materiality.py` | done | Direct/sector/macro match; SBP rate T-bill link; flags remain pending |

### Backend — Phase 6: Valuation & Technical Analysis Agents
| File | Status | Purpose |
|---|---|---|
| `backend/app/services/valuation.py` | done | `extract_company_info`, `run_dcf`, `run_monte_carlo`, `run_multiples` — yfinance fundamentals; WACC uses SBP rate; all Decimal; graceful insufficient_data on thin data |
| `backend/app/services/technical.py` | done | `compute_indicators` — pure pandas/numpy: RSI/MFI/MACD/SMA/EMA/crossover/support-resistance; DB-first, yfinance fallback; no DB writes |
| `backend/app/agent/tools/extract_company_info.py` | done | Thin wrapper → `ValuationService.extract_company_info` |
| `backend/app/agent/tools/run_dcf.py` | done | Thin wrapper → `ValuationService.run_dcf` |
| `backend/app/agent/tools/run_monte_carlo.py` | done | Thin wrapper → `ValuationService.run_monte_carlo` |
| `backend/app/agent/tools/run_multiples.py` | done | Thin wrapper → `ValuationService.run_multiples` |
| `backend/app/agent/tools/run_technical_analysis.py` | done | Thin wrapper → `TechnicalService.compute_indicators` |
| `backend/app/agent/prompts/valuation_prompt.py` | done | Valuation role system prompt — DCF/MC/multiples interpretation; ABSTRACTION_GUARDRAIL; no buy/sell/hold |
| `backend/app/agent/prompts/technical_prompt.py` | done | Technical role system prompt — RSI/MACD/crossover interpretation; daily EOD only; ABSTRACTION_GUARDRAIL |
| `backend/app/agent/roles/valuation.py` | done | `run_valuation()` — extracts ticker, gathers 4 services concurrently, calls LLM (task="hard") |
| `backend/app/agent/roles/technical.py` | done | `run_technical_analysis_role()` — extracts ticker, calls compute_indicators, calls LLM (task="reasoning") |
| `backend/app/api/analysis.py` | done | GET /analysis/company/{symbol}, POST /analysis/valuation/{symbol}, GET /analysis/technical/{symbol} — all read-only, auth required |
| `backend/tests/test_valuation.py` | done | 6 tests: WACC=SBP+ERP, MC distribution, thin-data no-fabrication, Decimal money, no buy/sell in prompt, PII guard |
| `backend/tests/test_technical.py` | done | 9 tests: RSI/MFI/MACD fixtures, MA exact values, golden/death cross, no DB writes, daily-data prompt note, PII guard |

### Frontend — Phase 5: Scaffold + Agent Conversation UI
| File | Status | Purpose |
|---|---|---|
| `frontend/package.json` | done | react 18.3.1, vite 5.4.8, ts 5.5.3, tailwind 3.4.13, chart.js 4.4.4, @supabase/supabase-js 2.45.0, lucide-react, clsx, tailwind-merge |
| `frontend/vite.config.ts` | done | @vitejs/plugin-react; `@` path alias → `./src` |
| `frontend/tsconfig.json` + `tsconfig.app.json` + `tsconfig.node.json` | done | Strict mode; react-jsx; `@/*` path alias |
| `frontend/tailwind.config.js` | done | All DESIGN.md §9 tokens + `rose: '#925B6A'`; Fraunces/Inter/IBM Plex Mono; radius sm/lg; dot-pulse/tool-spin/slide-up keyframes |
| `frontend/postcss.config.js` | done | tailwindcss + autoprefixer |
| `frontend/components.json` | done | shadcn/ui config (style: default, path aliases) |
| `frontend/index.html` | done | Vite entry; Google Fonts preconnect + Fraunces 600, Inter 400/500/600, IBM Plex Mono 500/600 |
| `frontend/.env.example` | done | `VITE_API_URL`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` |
| `frontend/src/main.tsx` | done | `ReactDOM.createRoot`; `<BrowserRouter>` wrap |
| `frontend/src/App.tsx` | done | Full lazy-loaded route tree: GuestGuard (/, /login, /register, /try), AuthGuard + onboarding (full-screen), AuthGuard + AppShell (core app), 404 → / |
| `frontend/src/styles/globals.css` | done | Tailwind directives; CSS custom properties for all tokens; streaming-dot/tool-ring/slide-up classes; `prefers-reduced-motion` kills all animations; jade focus ring; drawer entry/exit keyframes; minimal scrollbar |
| `frontend/src/lib/utils.ts` | done | `cn(...classes)` = clsx + tailwind-merge |
| `frontend/src/lib/supabase.ts` | done | `createClient(VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY)` |
| `frontend/src/lib/api.ts` | done | Typed API client: `streamChat` (SSE), `getChatHistory`, `getProfile`, `putProfile`, `getPortfolio`, `postSuggest`, `postConfirm`, `getFlags`, `dismissFlag`, `getNewsFeed`, `getCompanyInfo`, `postValuation`, `getTechnical`; all inject `Authorization: Bearer <supabase_token>` |
| `frontend/src/types/chat.ts` | done | `AgentRole`, `UserMessage`, `AssistantMessage`, `Message`, `CardData` discriminated union, `ToolEvent / ContentEvent / DoneEvent / SSEEvent` |
| `frontend/src/types/api.ts` | done | Mirrors backend Pydantic shapes: `ProfileResponse`, `PortfolioResponse`, `HoldingResponse`, `NewsItemResponse`, `FlagResponse`, `RateImpactCardData`, `ValuationResponse`, `TechnicalResponse`, `ChatHistoryItem` |
| `frontend/src/hooks/useReducedMotion.ts` | done | `useReducedMotion()` — listens to `matchMedia('(prefers-reduced-motion: reduce)')` |
| `frontend/src/hooks/useChat.ts` | done | `{ messages, isStreaming, send, loadHistory }` — manages `Message[]`, calls `streamChat`, accumulates content events, handles abort on unmount |
| `frontend/src/components/ui/button.tsx` | done | primary/ghost/outline variants; jade focus ring; 44px min-h touch target; active scale-[0.97] |
| `frontend/src/components/ui/card.tsx` | done | `Card / CardHeader / CardTitle / CardContent / CardFooter` — bg-card, border-line, radius-lg |
| `frontend/src/components/ui/badge.tsx` | done | `Badge` — default/info/gain/loss/gold/neutral variants; mono eyebrow typography |
| `frontend/src/components/ui/sheet.tsx` | done | `Sheet / SheetContent / SheetHeader / SheetTitle / SheetClose` — lightweight drawer primitive; bottom and right sides; drawer-enter CSS animation |
| `frontend/src/components/chat/StreamingIndicator.tsx` | done | Three 6px dots; `animate-dot-pulse`/`-2`/`-3`; `useReducedMotion` disables animation |
| `frontend/src/components/chat/ToolRunningPill.tsx` | done | 16px SVG ring (jade arc) + mono label; `tool-ring` CSS spin animation; `useReducedMotion` aware |
| `frontend/src/components/chat/UserMessage.tsx` | done | jade-soft bubble; right-aligned; `rounded-br-[6px]`; 200ms slide-up on mount via rAF |
| `frontend/src/components/chat/AgentMessage.tsx` | done | card bubble; left-aligned; `rounded-bl-[6px]`; accent-color mono role label; StreamingIndicator + ToolRunningPill integration; 200ms slide-up |
| `frontend/src/components/chat/Composer.tsx` | done | Auto-grow textarea (1–5 rows); Enter sends, Shift+Enter newlines; disabled while streaming; jade focus ring; active scale button |
| `frontend/src/components/chat/MessageList.tsx` | done | Auto-scroll to bottom; empty state with 4 example chips (no hover animation, active scale only); role label shown once per agent turn |
| `frontend/src/components/chat/ChatShell.tsx` | done | Flex-col container: `MessageList` (flex-1 overflow-y-auto) + `Composer` (pinned bottom) |
| `frontend/src/components/chat/cards/CardShell.tsx` | done | Shared wrapper: 3px accent bar, mono eyebrow, `animate-slide-up`, optional actions row |
| `frontend/src/components/chat/cards/ProfilerCard.tsx` | done | Accent `#2F4858`; risk/horizon/goal Badge chips (info variant); italic summary; `Confirm profile` action → `putProfile` |
| `frontend/src/components/chat/cards/OptimizerCard.tsx` | done | Accent `#0F6E56`; suggest mode: `AllocationDonut` + stat cells (return/risk/Sharpe) + rationale; analyze mode: two 120px donuts + concentration warning; `Confirm holdings` / `Adjust` actions |
| `frontend/src/components/chat/cards/NewsCard.tsx` | done | Accent `#925B6A`; staggered list (40ms×index); impact icon (↑/↓/→) + color; source tag + level Badge; links open new tab |
| `frontend/src/components/chat/cards/RateImpactCard.tsx` | done | Accent `#B8801A`; rate-move headline (▲/▼ + bps); price/yield impact pct; before/after value row (▲/▼ + strikethrough); `Review & re-optimize` when is_material |
| `frontend/src/components/chat/cards/ValuationCard.tsx` | done | Accent `#2F4858`; DCF intrinsic value in Fraunces display-l vs current price; `MonteCarloRange` SVG; P/E · EV/EBITDA · P/B vs peer median; data-gap notice (caption); disclaimer footer |
| `frontend/src/components/chat/cards/TechnicalCard.tsx` | done | Accent `#5A3D6B`; `RSIGauge` + MACD/MFI/MA compact row; crossover Badge (golden/death/none + text label); conflicting-signals callout (no resolution); S/R mono; disclaimer footer |
| `frontend/src/components/chat/cards/ChatReplyCard.tsx` | done | Accent `#0F6E56`; plain text wrapper in CardShell for standalone chat replies |
| `frontend/src/components/charts/AllocationDonut.tsx` | done | react-chartjs-2 Doughnut; cutout 68%; AC colors; no Chart.js legend; center label overlay; `animation: false` when `useReducedMotion()` |
| `frontend/src/components/charts/MonteCarloRange.tsx` | done | Pure SVG; p10–p90 band (info-soft rect); p50 dashed tick; current price jade line animates x-position 200ms ease-out via rAF; `prefers-reduced-motion`: no animation |
| `frontend/src/components/charts/RSIGauge.tsx` | done | SVG semicircle; 3 zones (jade-soft/line/loss-soft); needle rotates to RSI value; 200ms ease-out; `prefers-reduced-motion`: no animation; `<figure>` with sr-only `<figcaption>` |
| `frontend/src/pages/Chat.tsx` | done | Loads history on mount; auto-sends `location.state.seedMessage` if present (flag → chat bridge); simple header; `ChatShell` filling viewport |
| `frontend/src/components/layout/DashboardChatDrawer.tsx` | done | Replaced by DashboardChatComposer; kept for reference. Previously: Fixed jade trigger button (44px, bottom-right); `Sheet` bottom on mobile / right on ≥md |
| `frontend/src/components/layout/FlagCard.tsx` | done | severity Badge (color + text label); category mono tag; date; `Discuss` → navigate to `/chat` with seedMessage + opacity/scale exit animation; `Dismiss` → `dismissFlag` API |
| `frontend/src/components/layout/DashboardChatComposer.tsx` | done | Dark (--ink) docked bar pinned at bottom of dashboard; mono "Asaas agent" label; auto-grow textarea; example chips; send button; disclaimer footer; navigates to /chat on send |

### Frontend — Phase 6: Full page layer
| File | Status | Purpose |
|---|---|---|
| `frontend/src/context/AuthContext.tsx` | done | `AuthProvider`: `getSession()` + `onAuthStateChange`; upserts local user row once per session via `postSession()`; exports `useAuth()` |
| `frontend/src/components/layout/AuthGuard.tsx` | done | Redirects unauthenticated users to /login; shows jade spinner while resolving session |
| `frontend/src/components/layout/GuestGuard.tsx` | done | Redirects authenticated users to /dashboard (public-only guard) |
| `frontend/src/components/layout/AppShell.tsx` | done | Sticky top nav (wordmark + desktop NavBar + avatar → /settings); `max-w-5xl` content area; mobile bottom tab bar; fetches flag count for badge |
| `frontend/src/components/layout/NavBar.tsx` | done | `top` variant (desktop, `hidden md:flex`) and `bottom` variant (mobile, fixed); jade active indicator; loss-color flag badge |
| `frontend/src/components/charts/PerformanceLine.tsx` | done | Chart.js Line; tension 0.35, 2.5px jade stroke, 10% jade fill; no point markers at rest; mono axes; `animation: false` on reduced-motion |
| `frontend/src/components/charts/Sparkline.tsx` | done | Pure SVG polyline; 64×24px; jade if positive, loss if negative; 1.5px stroke; no axes |
| `frontend/src/pages/Landing.tsx` | done | Editorial homepage per DESIGN.md §1: hero ("Your money, understood."), product peek mock, asset classes grid, features ("Not a dashboard. An advisor."), agent showcase, CTA, footer |
| `frontend/src/pages/Login.tsx` | done | Centered card; email + password inputs; `supabase.auth.signInWithPassword` → `postSession()` → /dashboard; inline error |
| `frontend/src/pages/Register.tsx` | done | Same card; email + password + confirm; `supabase.auth.signUp` → `postSession()` → /onboarding; carries `guestData` in location state |
| `frontend/src/pages/onboarding/Questionnaire.tsx` | done | `getQuestions()` on mount; step-by-step with jade progress bar; single-select (jade segmented), multi-select (checkbox rows), capital PKR input; `postQuestionnaire()` on last step → /onboarding/holdings |
| `frontend/src/pages/onboarding/DeclareHoldings.tsx` | done | "Own investments" vs "Start fresh" split; holdings form with debounced `searchMarket()` dropdown; qty/price/date inputs; up to 20 rows; `declareHoldings()` → /onboarding/suggestion |
| `frontend/src/pages/onboarding/Suggestion.tsx` | done | Calls `postSuggest()` if no state.portfolio; shows `<OptimizerCard mode="suggest">` full-width; Confirm → `postConfirm()` → /dashboard; Adjust → /chat with seed message |
| `frontend/src/pages/Dashboard.tsx` | done | Two-column: hero value (Fraunces) + delta, time-range pills, PerformanceLine chart, 4-stat strip (P&L, return, Sharpe with SBP note), holdings table; right: risk score bar + "Ask agent" link, activity feed with materiality tags, allocation donut; docked dark agent composer |
| `frontend/src/pages/News.tsx` | done | `getNewsFeed()` on mount; filter pills (All/Direct/Sector/Macro); impact symbol (↑/↓/→) + Badge; source tag + date; empty state per filter |
| `frontend/src/pages/Flags.tsx` | done | `getFlags()` on mount; Active/Dismissed tabs with count badge; `FlagCard` list; empty state per tab |
| `frontend/src/pages/HoldingDetail.tsx` | done | `/holdings/:symbol`; company header + price; Overview/Valuation/Technical/News tabs; tab-lazy-loaded: `ValuationCard` + `TechnicalCard` full-width; news filtered to symbol |
| `frontend/src/pages/Settings.tsx` | done | Risk profile (Badge chips + summary + re-take link); Account (email + sign-out → /); Display placeholder |
| `frontend/src/pages/PortfolioManagement.tsx` | done | Current allocation (donut + stat cells + holdings list); Re-optimise button → `reoptimize()` → `OptimizerCard` draft; history placeholder |
| `frontend/src/pages/GuestAnalyze.tsx` | done | No-auth holdings entry (symbol/qty/price rows); `analyzeGuest()` → `OptimizerCard mode="analyze"` + rationale + rebalance actions; 429 → rate-limit CTA; "Save & track it" → /register with guestData state |
| `frontend/src/lib/api.ts` | done | Added: `postSession`, `getMe`, `getQuestions`, `postQuestionnaire`, `declareHoldings`, `getPerformance`, `getDiversification`, `reoptimize`, `analyzeGuest` (no auth, credentials include), `searchMarket` |
| `frontend/src/types/api.ts` | done | Added: `UserResponse`, `QuestionOption`, `QuestionDefinition`, `QuestionnaireResponse`, `DeclareHoldingInput`, `PerformanceResponse`, `DiversificationResponse`, `GuestAnalyzeResponse`, `InstrumentSearchResult` |

---

## 2. Change history

_Newest first. One entry per change set._

### 2026-10-24 — Dashboard rebuilt to the Ember V15 layout in the Asaas palette
- created: `frontend/src/components/dashboard/` — `primitives.tsx` (DashCard with framer-motion hover-lift + stagger, `Money` (₨ always in IBM Plex Mono — Fraunces renders U+20A8 as "Rs"), whole-rupee formatters, DeltaPill with arrow+sign, AssetChip in `--ac-*` colours), `HeroStats.tsx` (48px+ hero value, investments/cash split bar, 2×2 stat cards incl. honest "Change since <date>"), `RiskGauge.tsx` (SVG semicircle 0–100 gauge), `InsightCards.tsx` (risk gauge card, allocation by asset class, the single jade "Ask Asaas" card), `ActivityCards.tsx` (performance area card, month-end value bars with peak callout, upcoming events week strip), `HoldingsCard.tsx` (row list with chips, 30-point sparklines, P&L pills, weight bars; alerts & news feed).
- edited: `frontend/src/pages/Dashboard.tsx` — new grid: hero+stats → gauge · allocation · jade agent → performance · events → holdings+activity · alerts/news+wallet → monthly bars · sentiment → risk analytics tiles. `MotionConfig reducedMotion="user"`. No horizontal scroll at 390px (holdings table replaced by rows).
- edited: `frontend/src/components/charts/PerformanceLine.tsx` — true time (linear) x-axis so snapshot gaps aren't drawn as cliffs; monotone interpolation (no overshoot); jade 12%→0 gradient; peak dot + callout; Y ticks from `lib/chartFormat.ts` (`pkrTick` picks decimals from the tick step — fixes "₨41K" ×5; suggested bounds hug the data).
- edited: `frontend/src/components/charts/AllocationDonut.tsx` — palette now reads `--ac-*` tokens (was off-brand coral/purple/amber hex); centre value accepts a node.
- edited: `WalletCard.tsx` (whole rupees, Money), `RiskPanel.tsx` (`variant="grid"` tile layout), `MarketSentimentGauge.tsx`, `MyActivity.tsx` (radius/shadow aligned).
- created: `GET /portfolio/events` (`backend/app/api/portfolio.py`) — next 120 days of SBP MPC meetings (scraped from SBP's advance MPC calendar, `SBPAdapter.fetch_mpc_dates`, cached 24h via `core/market.get_mpc_dates`) + maturity / next coupon of held T-bills, PIBs and sukuk from PSX debt-market data. No earnings dates (no source).
- fixed: `psx_debt_adapter.py` header match — PSX headers are "Coupon/Rental" (no space); previous/next coupon dates were empty.
- added deps: `framer-motion` 12.43.0 (pinned). Tests: Dashboard suite updated for new formatting (17/17).
- data note: `portfolio_snapshots` for 2026-07-03…07-09 hold ~₨4.0M for a ~₨40–100K portfolio and there are no snapshots 07-09…10-16; the monthly bars and 6M/1Y views show this as-is.

### 2026-10-24 — Live govt yields (no hardcoded), USD/PKR never raises, shared frontend query cache
- edited: `backend/app/core/market.py` — `get_usd_pkr_rate()` never raises: cache → yfinance → DuckDuckGo → last-known-good → `FX_RATE_FALLBACK` (276.51, logged as STALE, never cached); `last_fx_rate_source` tag; live sources skipped for 5 min after all fail.
- edited: `backend/app/data/adapters/psx_debt_adapter.py` — rows parsed by header name; the Government Debt table (10 columns) was silently dropped by a `len(cells) < 12` check, so PIBs/T-bills never reached yields, `get_instrument` or the debt refresh. `fetch_yields_by_tenor` rewritten: newest unmatured issue with a non-zero rate per tenor (PIB-nY, GIS-nY-FRR/VRR); T-bills excluded (0% coupon discount instruments).
- edited: `backend/app/data/adapters/sbp_adapter.py` — removed the hardcoded ~20% yield fallbacks and the dead auction/key-rates scrapers. `fetch_tbill_rates()` = SBP homepage latest-auction cut-offs (MTB 1M–12M, fixed PIB 2Y–10Y) merged over PSX debt-market rates; returns {} rather than fabricating.
- edited: `backend/app/api/market.py` — ticker rates use merged yields and `get_sbp_rate()` (removed the `20.0` policy-rate fallback).
- data note: `prices` holds 115 rows (2026-06-26 → 2026-10-24) for MTB/PIB/GIS that are exactly the old hardcoded values (written by `tbill_watch`); not deleted — owner decision.
- created: `frontend/src/lib/queries.ts` — TanStack Query client + hooks (portfolio, profile, performance w/ live upgrade, news, flags, wallet, cash txns, risk, sentiment, ticker, watchlist, diversification) and invalidation helpers. 60s staleTime, 30 min gc, no retry on 4xx.
- edited: `frontend/src/main.tsx` (provider), `context/AuthContext.tsx` (sign-in routing seeds the cache; cache cleared on sign-out/new sign-in), `pages/{Dashboard,Flags,Chat,PortfolioManagement,Settings,Watchlist,News,HoldingDetail}.tsx`, `components/layout/{AppShell,WalletCard,RiskPanel,MarketSentimentGauge,MyActivity,MarketTicker}.tsx` — read through the shared cache; Dashboard's module cache removed; buys/sells/deposits invalidate affected keys. Alerts page no longer calls the dismiss API twice. Ticker interval pauses while the tab is hidden; News scrape poll skips ticks while hidden.
- edited: `frontend/src/__tests__/Dashboard.test.tsx` — renders inside a fresh QueryClientProvider per test. `package.json`: `@tanstack/react-query` 5.104.1 (pinned).

### 2026-10-24 — Production fixes: SBP 403, fail-safe Redis, PKT scheduler, LLM provider depth
- edited: `backend/app/data/adapters/sbp_adapter.py` — all SBP fetches go through `_get()` using `curl_cffi` Chrome impersonation; Cloudflare 403'd httpx's TLS handshake even with browser headers. Policy rate scrapes live again (11.50%).
- edited: `backend/app/core/market.py` — `get_sbp_rate()` never raises: cache → live scrape → last-known-good → `SBP_RATE_FALLBACK` (11.50%, logged as STALE FALLBACK, never written to Redis). `last_sbp_rate_source` tags each value (`cache|live|last_good|fallback`); a failed scrape is not retried for 5 min. Guest analyze returns 200 on a flushed Redis.
- edited: `backend/app/core/redis.py` — `FailSafeRedis`: connection/timeout errors make commands return `None` (cache miss) and skip Redis for 30s; PING still raises so health reports `degraded`. 2s connect timeout, no retries. One "Redis unreachable — running without cache" warning per outage.
- edited: `backend/app/main.py` — scheduler + every trigger pinned to `Asia/Karachi`; `daily_eod` 12:00 local → **17:00 PKT** (after PSX close); `refresh_debt_instruments` 00:01 PKT; `warm_prices` Mon–Fri 09:00–15:50 PKT; `backfill_prices` 1st of month 01:00 PKT. Next-run time of every job is logged at startup. Startup Redis failure logged as a warning.
- edited: `backend/app/agent/llm_router.py` — every tier Groq-first (hard: `gpt-oss-120b` → Gemini 2.5 Pro). Per-tier timeouts (`TASK_TIMEOUTS`: hard 30s, others 15s) and output caps (`TASK_MAX_TOKENS`: light 512 — Groq Qwen's free tier allows 1000 output tokens/min and reserves `max_tokens` up front). Light tier gains `gpt-oss-20b` as an in-Groq fallback (separate rate-limit bucket). A 401/403 disables that provider for the process (`_rejected`); Gemini now raises on 401/403 instead of returning `None`, and a non-200 Gemini stream raises instead of yielding nothing.
- edited: `backend/requirements.txt` — `curl_cffi` and `tzdata` made explicit (were transitive via yfinance).

### 2026-10-24 — Backend latency + reliability: LLM timeouts, batched prices, orchestrator join
- edited: `backend/app/agent/llm_router.py` — every provider client gets `timeout=15s, max_retries=0` (Gemini httpx calls too); the fallback chain is the retry, so a stuck provider costs ≤15s instead of the SDK's 10-min wait + 2 retries. New `_chain()` skips providers with an empty key (debug log) and appends Mistral (only if keyed) + OpenRouter free slot as last resorts. Chains now: light → Groq `qwen/qwen3.8-27b` → Gemini Flash; chat/reasoning → Groq `openai/gpt-oss-120b` → Gemini Flash; hard → Gemini 2.5 Pro → Groq `gpt-oss-120b`; OpenRouter fallback `google/gemma-4-31b-it:free`. Groq retired `llama-3.1-8b-instant` / `llama-3.3-70b-versatile` and OpenRouter's `llama-3.3-70b-instruct:free` slug is gone — all LLM calls were failing before this swap.
- edited: `backend/app/api/portfolio.py` — the three per-symbol `get_price()` loops (guest analyze, suggest draft holdings, `_recompute_weights`) now make one concurrent `get_prices()` call; same None/fallback handling. Guest analyze fetches USD/PKR + SBP rate with `asyncio.gather`. Measured: 9 cold symbols 22.2s → 9.8s.
- edited: `backend/app/agent/orchestrator.py` — context load fetches holdings + instruments in one outer join instead of one query per holding (output identical across 47 portfolios; ~760ms → ~160ms per chat message).
- edited: `backend/app/main.py` — `warm_prices` moves from a flat 2h interval to every 10 min during PSX hours (Mon–Fri 04:00–10:50 UTC = 09:00–15:50 PKT), trigger pinned to UTC.

### 2026-06-23 — Agent conversation memory + optimizer intent-aware tool wiring
- created: `backend/app/agent/memory.py` — `format_history()` pure helper; renders last-N chat turns as a labeled block (`Recent conversation:` + `User:`/`Asaas:` lines); returns `""` on empty/blank so roles can append unconditionally. Tolerates junk entries
- edited: `backend/app/agent/types.py` — added `history: list` field to `AgentState` (`[{"role","content"}]` — never tool_calls/PII)
- edited: `backend/app/agent/orchestrator.py` — `load_context_node` now queries last `HISTORY_WINDOW` (16) `chat_messages` (desc → reversed to chronological) into `state["history"]`; sets `[]` in the no-user early-return and in `initial_state`; added `HISTORY_WINDOW=16` constant. `classify_node` now sees the last 6 turns so referent-following messages ("what about gold?") route correctly instead of defaulting to general
- edited: all 7 role files (`chat`, `profiler`, `news_materiality`, `optimizer`, `rate_impact`, `technical`, `valuation`) — `user_content` refactored into a `parts` list that interleaves `format_history(state.get("history", []))` between the payload and the `User:` line; no `call_llm` signature change, no prompt-template edits
- rewritten: `backend/app/agent/roles/optimizer.py` — now intent-aware with 3 branches: (1) `track` → `track_value` on existing portfolio, creates NO new portfolio, exception-safe (raw errors caught → calm "data may still be loading" message, no traceback leak); (2) `suggest`/`diversification` + existing confirmed portfolio → `reoptimize` (ownership-checked, confirmed untouched, new tagged draft); (3) declined reoptimize → reuses an existing draft instead of stacking a new one (anti-proliferation via `_existing_draft_id`/`_draft_snapshot` helpers); falls back to `suggest_portfolio` only when nothing pending
- rewritten: `backend/app/agent/tools/__init__.py` — registry now documents reachability: 13 CHAT-REACHABLE tools (with their owning role) vs 2 REST-ONLY (`confirm_holdings`, `flag_event`) deliberately unwired from chat per RULES.md A1.1/A1.2
- created: `backend/tests/test_agent.py` Part A + B tests — `test_format_history` (pure unit, PASSES); `test_optimizer_track_intent_calls_track_value` + `test_optimizer_suggest_with_existing_portfolio_uses_reoptimize` (DB-backed, skip without TEST_DATABASE_URL — assert track-creates-no-portfolio and reoptimize-leaves-confirmed-untouched invariants)
- out of scope: `confirm_holdings` + `flag_event` remain REST/monitor-only by design (respect RULES.md A1.1 + the existing `test_no_auto_action_on_confirm_message` gate)
- verified: all 11 changed modules import cleanly; `test_format_history` passes; the 10 failures in `test_onboarding`/`test_optimizer`/`test_portfolio` are pre-existing (stale `len(QUESTIONS)==5` assertion, httpx `app=` API removal, optimizer rounding drift) and do NOT import any changed agent code

### 2026-06-18 — News scrapers replaced: 6 working sources, 121 unique items
- created: `backend/app/data/news/financial_daily.py` — scrapes thefinancialdaily.com for business/finance news (30 items)
- created: `backend/app/data/news/profit_scraper.py` — scrapes profit.pakistantoday.com.pk for economy/business news (30 items)
- created: `backend/app/data/news/tribune_scraper.py` — scrapes tribune.com.pk/business for business news (30 items)
- created: `backend/app/data/news/app_scraper.py` — scrapes app.com.pk/business for government/business news (18 items)
- rewritten: `backend/app/data/news/psx_scraper.py` — old RSS URL dead (404); scrapes PSX main page announcements (13 items)
- rewritten: `backend/app/data/news/sbp_scraper.py` — all press URLs dead (404); Google News RSS fallback (30 items)
- rewritten: `backend/app/data/news/business_recorder.py` — old RSS blocked (403 Cloudflare); Google News RSS fallback (50 items)
- updated: `backend/app/data/news/__init__.py` — added FinancialDailyScraper, ProfitScraper, TribuneScraper, APPScraper exports
- updated: `backend/app/workers/news_monitor.py` — replaced broken scrapers with 6 working sources (PSX, Dawn, FinancialDaily, Profit, Tribune, APP)
- verified: all 6 scrapers produce 151 raw items → 121 unique after normalize+dedup

### 2026-06-18 — End-to-end codebase audit: map, contracts, mismatches, dead code
- fixed: `backend/app/api/news.py` — `/news/feed` now queries real `news_items` table from DB with field mapping (`level`→`impact_level`, `sentiment`→`impact`), joins `news_holding_link` for `affected_symbols`; falls back to mock data only when DB is empty (first run)
- created: `backend/app/api/news.py` — new `POST /news/scrape` endpoint triggers `run_news_monitor()` asynchronously, returns immediately
- fixed: `frontend/src/pages/News.tsx` — added "🔄 Refresh" button that calls `POST /news/scrape`, waits 3s, then reloads the feed; shows "⏳ Scraping…" while running
- fixed: `frontend/src/lib/api.ts` — added `triggerNewsScrape()` function for the new endpoint
- fixed: `backend/app/data/adapters/psx_debt_adapter.py` — `fetch_all_instruments()` returned `Decimal` values for `face_value`, `issue_size`, `coupon_rate`, `outstanding_days`, `remaining_years` which are not JSON-serializable; converted all to `float` or `None` so the `/market/debt-market` endpoint can serialize without error
- fixed: `frontend/src/lib/api.ts` — `searchMarket()` query param `?q=` → `?query=` to match backend `@router.get("/search", query: str = Query(...))` (was silently failing — DeclareHoldings search broken)
- fixed: `backend/app/services/materiality.py` — (1) removed early return at line 81-82 that left items with NULL `level`/`sentiment`/`materiality_score` when no instruments matched; now always sets defaults (macro/neutral/0.1). (2) Removed premature `self.db.commit()` at line 149 — worker owns the commit now
- fixed: `backend/app/workers/news_monitor.py:60` — removed dead `if False` debugging branch in dedup check
- fixed: `frontend/src/pages/News.tsx` — added null guards on `item.impact.charAt()` and `item.impact_level.charAt()` (were crashing with TypeError when backend returned null); increased refresh wait from 15s to 45s to match scraper duration (4 scrapers × 15s timeout = 60s worst case)
- fixed: `backend/app/models/flag.py` — added `lazy="noload"` to `portfolio` and `news_item` relationships to prevent MissingGreenlet async lazy-loading errors in the /flags endpoint
- fixed: `backend/app/api/portfolio.py` — removed duplicate `from app.data.cache import get_price` and `from app.services.optimizer import PortfolioOptimizer` imports (lines 51-53 and 87-88 were identical)
- audit: full codebase map produced — 29 backend endpoints, 7 routers, 9 agent roles, 7 LLM task types, 6 adapters, read-through cache with per-asset-class TTL
- audit: contract table built — all 25 frontend api.ts functions matched to backend endpoints
- audit: agent chain verified — orchestrator classifies → routes → role → tools → LLM → SSE → card
- audit: data sources verified — yfinance (PSX/global/commodities), CoinGecko (crypto), SBP scrape (rates), FRED (macro), AlphaVantage (commodity backup)
- verified: `TickerItem` shape matches backend `_price_item()` — `change`/`change_pct` are `number | null` on both sides
- verified: `GuestAnalyzeResponse.rebalance_actions` is `string[]` on both sides
- verified: `GuestAnalyzeResponse.current_metrics` keys match (backend `Dict[str, Any]` → frontend optional fields)
- verified: `AgentRole` names match — backend `_INTENT_TO_ROLE` maps `news`→`news_materiality`, `rate`→`rate_impact` per frontend type
- verified: `putProfile` is PUT on both sides; `postSession`/`getMe` endpoints exist
- verified: all 7 analysis endpoints match frontend calls
- note: `DashboardChatDrawer.tsx` — dead code, exported but never imported (replaced by `DashboardChatComposer`)
- note: `getMe()` and `getDiversification()` in api.ts — exported but never imported by any component
- note: `NewsChat.tsx` uses raw `fetch()` instead of typed `streamChat()` — inconsistent but functional
- note: `PortfolioResponse.concentration_warning` optional field used by OptimizerCard/PortfolioManagement but backend PortfolioBase doesn't return it (harmless — optional, UI handles gracefully)
- note: chat history only returns user messages (assistant not persisted to DB) — `agent_role` always falls back to 'chat'

### 2026-06-18 — Hardcoded values audit: USD/PKR, SBP rate, T-bill yields eliminated
- audit: full backend scan for hardcoded financial numbers served as live data
- created: `backend/app/core/market.py` — shared `get_usd_pkr_rate()` (yfinance PKR=X, Redis 1h cache) and `get_sbp_rate()` (SBP adapter, Redis 1h cache) with stale-cache fallback
- fixed: `backend/app/services/performance.py` — replaced 2× hardcoded `Decimal("278.50")` USD/PKR with `await get_usd_pkr_rate()` (lines 68, 111)
- fixed: `backend/app/workers/daily_eod.py` — replaced hardcoded `Decimal("278.50")` USD/PKR with `await get_usd_pkr_rate()` (line 87)
- fixed: `backend/app/services/valuation.py` — replaced `_DEFAULT_SBP_RATE = Decimal("0.20")` with 3-layer fetch: shared helper → SBP adapter → 17% last resort (line 21)
- fixed: `backend/app/agent/tools/suggest_portfolio.py` — replaced `_DEFAULT_SBP_RATE = Decimal("0.20")` with same 3-layer fetch (line 29)
- fixed: `backend/app/agent/roles/rate_impact.py` — removed `_DEFAULT_OLD_RATE = Decimal("0.20")`; now uses shared helper → adapter → graceful error message (line 26)
- fixed: `backend/app/services/rate_impact.py` — replaced `latest_yield = Decimal("0.2000")` with `continue` (skip symbol, don't fake yield) (line 86)
- remaining fallback: `sbp_adapter.py:77` `Decimal("0.2000")` — 3rd-level fallback when ALL 3 scraping strategies fail; now behind shared helper + stale cache (acceptable)

### 2026-06-18 — Market ticker audit: data flow, freshness, refresh, staleness + hardcoded data fixes
- audit: 7-point audit of `/market/ticker` data flow (TECH.md §4 + §6 cadence)
- fixed: `backend/app/main.py` — added APScheduler in lifespan: `crypto_refresh` every 60s, `daily_eod` at 12:00 UTC, `tbill_watch` every 6h, `news_monitor` at 08:00 UTC. Previously workers existed but were never scheduled
- fixed: `backend/app/api/market.py` — wrong import `app.models.news_item` → `app.models.news` for `NewsItem` (would silently swallow ImportError, hiding news from ticker)
- fixed: `backend/app/api/market.py` — ticker now uses `fetch_price_with_change()` for proper day-over-day change (was using open price = intraday change); removed hardcoded SBP fallback values from exception handler
- rewritten: `backend/app/data/adapters/sbp_adapter.py` — replaced all hardcoded fallback returns with real scraping: 3-strategy policy rate fetch (homepage → monetary policy page → key rates page), auction results page scraping for T-bill/PIB/GIS yields with regex tenor matching, key rates page fallback. Validation: yields must be in 5–50% range. Fallbacks only returned on total scraping failure
- rewritten: `backend/app/data/adapters/yfinance_adapter.py` — added `fetch_price_with_change()` method: fetches 5d history to get 2 trading days, returns `price` + `prev_close` for proper day-over-day change calculation; falls back to single-day data if 2-day unavailable
- fixed: `frontend/src/components/layout/MarketTicker.tsx` — added 60s polling interval (was fetch-once-on-mount); always displays "as of [time]" timestamp (was only shown when `stale=true`); cleanup on unmount

### 2026-06-17 — Guest analyze: real analysis with live prices + optimizer
- rewritten: `backend/app/api/portfolio.py` `analyze_guest` endpoint — now performs real analysis: fetches live prices via read-through cache, looks up instrument metadata (asset class, sector), calculates current portfolio weights and diversification score, detects concentration warnings (>30%), runs heuristic optimizer with SBP risk-free rate, generates plain-language rebalance actions, returns real rationale
- edited: `backend/app/schemas/portfolio.py` — `GuestAnalyzeResponse.rebalance_actions` changed from `List[Dict]` to `List[str]` for plain-language action strings
- rewritten: `frontend/src/pages/GuestAnalyze.tsx` — added "Portfolio Analysis" section showing: current value, number of holdings, diversification score (0-100%), concentration warnings, current allocation weights; updated placeholders to use MTB-3M
- edited: `frontend/src/types/api.ts` — `GuestAnalyzeResponse.current_metrics` widened to include `total_value_pkr`, `num_holdings`, `asset_classes`, `diversification_score`, `concentration_warnings`, `weights`

### 2026-06-17 — Government Securities: MTBs, PIBs, GIS (SBP auction model)
- rewritten: `backend/app/data/seed.py` — expanded from 3 T-bill instruments to 10 government securities: 3 MTBs (3M/6M/12M, fortnightly auctions), 4 PIBs (3Y/5Y/10Y/20Y, need-basis auctions), 2 GIS (3Y Fixed/Variable Rate, Shariah compliant); added metadata with auction frequency, settlement, tenor, type
- rewritten: `backend/app/data/adapters/sbp_adapter.py` — added PIB and GIS yield fetching; documented SBP auction structure (MTBs fortnightly Wednesdays, PIBs need-basis, GIS Shariah); legacy symbol mapping for backward compatibility
- rewritten: `backend/app/api/market.py` ticker — now returns SBP rate + MTBs (3M/6M/12M) + PIBs (3Y/5Y/10Y) + GIS (3Y) with proper yield percentages; fallback rates updated to 20%+ range
- rewritten: `backend/app/services/rate_impact.py` — handles all government securities (MTBs, PIBs, GIS); added duration multipliers for interest rate sensitivity; categorizes holdings by type in flag messages; duration-based price impact explanation
- rewritten: `backend/app/workers/tbill_watch.py` — updated to fetch yields for all government securities (MTBs, PIBs, GIS) from SBP adapter
- rewritten: `backend/app/agent/prompts/rate_impact_prompt.py` — updated to explain MTB/PIB/GIS-specific impacts; added duration risk explanation; government securities terminology throughout
- updated: `frontend/src/components/layout/MarketTicker.tsx` — shows SBP, 3M T-Bill, 12M T-Bill, 5Y PIB, 3Y Sukuk in scrolling tape
- updated: `frontend/src/components/charts/AllocationDonut.tsx` — fixed AC_COLORS to use DESIGN.md tokens (was using dark theme colors)
- updated: `frontend/src/pages/Landing.tsx` — demo chip updated to "MTB 20.1%"

### 2026-06-17 — Homepage DrapCode SaaS style + individual stock ticker
- rewritten: `frontend/src/pages/Landing.tsx` — DrapCode SaaS marketing layout: hero with headline ("Build a Smarter Portfolio with Asaas"), dual CTA, dashboard preview card (mock value/chart/holdings chips); stats strip (PSX market cap, listed companies, agents, tools, LLMs); alternating feature sections (Automated Investing + allocation donut, AI Agents + chat mock); 6-card Key Features grid (Goal Tracking, Automated Allocation, Risk Profiling, Real-Time Sync, Advisor Agent, Comprehensive Reporting); 4-step "How Asaas Works" section; "Built for Pakistan" benefits grid; expandable FAQ (5 questions); final CTA ("Launch Your Wealth Platform Today"); footer
- rewritten: `frontend/src/components/layout/MarketTicker.tsx` — individual live stock scrolling tape: shows each PSX stock (HBL, UBL, MCB, etc.) individually + KSE-100 index + crypto (BTC, ETH) + gold + oil + SBP rate + USD/PKR; CSS translateX scroll with pause on hover, seamless infinite loop, prefers-reduced-motion static row

### 2026-06-17 — Homepage + Dashboard rebuild, per-asset-class ticker, DESIGN.md palette fix
- edited: `frontend/tailwind.config.js` — reverted entire color palette from dark theme (#111111) to DESIGN.md §9 warm paper palette (#F6F4ED paper, #FFFEFB card, #16201C ink); removed lime neon accent; updated rose/plum/gain/loss/info tokens to match spec
- edited: `frontend/src/styles/globals.css` — reverted all CSS custom properties to DESIGN.md §9 warm paper palette; updated asset-class accent tokens
- edited: `frontend/src/components/charts/PerformanceLine.tsx` — changed default chart color from lime (#CAFF00) to jade (#0F6E56); updated all hardcoded dark-theme hex values in chart options to warm paper palette colors
- edited: `frontend/src/pages/Dashboard.tsx` — changed chart lineColor prop from lime to jade
- edited: `backend/app/api/market.py` — extended ticker endpoint: added KSE-100 index (^KSE), USD/PKR exchange rate (PKR=X), T-bill yield (TBILL-3M), latest news headline; added db session dependency for news fetch
- rewritten: `frontend/src/components/layout/MarketTicker.tsx` — per-asset-class aggregates (KSE-100, Crypto, Gold, Oil, T-Bills, USD/PKR) instead of individual tickers; CSS translateX scroll (30-50s loop); pause on hover; seamless infinite loop via doubled set; prefers-reduced-motion shows static row; graceful fallback with "as of" timestamp; no raw hex — tokens only
- rewritten: `frontend/src/pages/Landing.tsx` — full editorial homepage per DESIGN.md §1: hero with "Your money, understood." (jade emphasis), dual CTA (Try it free + See how it works), trust line (no card, built for Pakistan), product peek (mock dashboard card with value/delta/chart/holdings), asset classes grid (6 classes), features section ("Not a dashboard. An advisor." with 3 cards), agent showcase (dark card with example chips), CTA section, footer with "suggestions, not financial advice"
- rewritten: `frontend/src/pages/Dashboard.tsx` — time-range pills (1d/1w/1m/6m/1y) on performance chart; risk score bar with "Why this score? Ask the agent →" link; activity feed with materiality tags (material/review/info); replaced floating chat button with docked dark agent composer; SBP risk-free rate noted on expected return stat
- created: `frontend/src/components/layout/DashboardChatComposer.tsx` — dark (--ink) docked bar pinned at bottom of dashboard; mono "Asaas agent" label; auto-grow textarea; example chips; send button; disclaimer footer; navigates to /chat on send

### 2026-06-17 — Homepage screener, IPS questionnaire, multi-asset holdings, bond interest rate tracking
- edited: `backend/app/services/questionnaire.py` — rewritten with 8 IPS-based questions: goal (return objective), risk_willingness (behavioral: "20% drop"), risk_ability (capacity: "handle loss"), horizon, capital, liquidity needs, tax considerations, excluded sectors. Risk tolerance = min(willingness, ability) per IPS rule
- edited: `frontend/src/pages/onboarding/Questionnaire.tsx` — enhanced with question icons, IPS subtitle, larger inputs, btn-press feedback, tinted error states, "Investment Policy Statement" header
- edited: `frontend/src/pages/Landing.tsx` — transformed into market screener: live data tables for PSX stocks (8), crypto (4), bonds/T-bills (6), commodities (3); tabbed interface with search filter; asset-class color dots; price change badges; sector column for stocks; volume column
- edited: `frontend/src/pages/GuestAnalyze.tsx` — multi-asset support: asset type selector (stock/bond/crypto/commodity) with color-coded dots; bond-specific fields (interest rate at buy time, buy date); crypto/commodity hints for live price fetching; asset type summary badges; better empty states
- edited: `backend/app/api/market.py` — added `GET /market/ticker` endpoint returning prices for 12 instruments + SBP rate + news headline; calculates day-over-day change percentage
- created: `frontend/src/components/layout/MarketTicker.tsx` — horizontal scrolling ticker bar with stock prices, crypto, commodities, SBP rate, news headline; CSS animation, pause-on-hover, skeleton loading, gradient fade edges, reduced-motion support
- edited: `frontend/src/components/layout/AppShell.tsx` — integrated MarketTicker at top of every authenticated page

### 2026-06-17 — Market ticker: horizontal scrolling bar with live data
- created: `frontend/src/components/layout/MarketTicker.tsx` — horizontal scrolling ticker bar showing stock prices (HBL, UBL, MCB, ENGRO, OGDC, etc.), SBP interest rate, crypto prices (BTC, ETH), commodities (Gold, Oil), and latest news headline; auto-scrolls with CSS animation; pauses on hover; respects prefers-reduced-motion; gradient fade edges; skeleton loading state; asset-class color dots
- edited: `backend/app/api/market.py` — added `GET /market/ticker` endpoint returning prices for 12 key instruments + SBP rate + latest news headline in a single call; calculates day-over-day change percentage; no auth required
- edited: `frontend/src/lib/api.ts` — added `getTicker()` function and `TickerItem` interface
- edited: `frontend/src/components/layout/AppShell.tsx` — integrated `MarketTicker` at top of every authenticated page, above the nav bar

### 2026-06-17 — Design enhancement: fintech-grade UX patterns (§5d)
- edited: `doc/DESIGN.md` — added §5d "Fintech UX patterns" with 10 subsections: progressive disclosure, skeleton loading, micro-interactions, contextual tooltips, smart empty states, dashboard enhancements, chat enhancements, onboarding enhancements, mobile-specific enhancements, trust signals
- edited: `doc/DESIGN.md` — updated §9 Tailwind config with new tokens: jade.dark, rose, plum, rounded.xl, shadow.glow, 6 new animations (skeleton-shimmer, count-up, fade-in, scale-in, collapse-out)
- edited: `frontend/tailwind.config.js` — added jade.dark, rose, plum colors; rounded.xl; shadow.glow; 6 new keyframes and animations
- edited: `frontend/src/styles/globals.css` — added skeleton shimmer utility, count-up animation, tooltip CSS, flag dismiss animation, button press feedback, holdings expand/collapse, empty state icon styling
- edited: `frontend/src/pages/Dashboard.tsx` — added skeleton loading state, stat cards in grid layout with hover shadow, better P&L badge styling, "As of" timestamp, empty state with icon, "View all N holdings" link
- edited: `frontend/src/pages/Landing.tsx` — added stats bar (7 agents, 15 tools, 4 LLMs, PKR), "How it works" 3-step section, CTA section, footer with data sources, sticky header with backdrop blur, trust signal
- edited: `frontend/src/pages/Login.tsx` — split layout with jade branding panel on desktop, better input styling (rounded-lg, hover/focus transitions), error state in tinted box, "Sign up free" CTA
- edited: `frontend/src/components/chat/MessageList.tsx` — enhanced empty state with wordmark, jade divider, tagline, 2x2 chip grid, "Or type your own question" hint
- edited: `frontend/src/components/layout/FlagCard.tsx` — severity-based left border (rust/gold), tinted background, slide-out dismiss animation, btn-press feedback on actions

### 2026-06-17 — Integration check: frontend ↔ backend
- fixed: `frontend/.env` — Supabase URL corrected from `Asaas.supabase.co` to `tgbeavoesxpzalysegnm.supabase.co` to match backend's project (auth was broken — JWT issued by wrong project)
- fixed: `frontend/src/lib/api.ts` — `putProfile` changed from POST to PUT to match backend `@router.put("/profile")` (was 405 Method Not Allowed)
- fixed: `frontend/src/lib/api.ts` — added 4 response transformers (`transformPortfolio`, `transformFlag`, `transformNews`, `transformHolding`) to map backend Pydantic shapes to frontend types
- fixed: `frontend/src/lib/api.ts` — `getChatHistory` now maps backend fields to frontend `ChatHistoryItem` shape
- fixed: `frontend/src/types/api.ts` — `PortfolioResponse`: `portfolio_id` → `id`, added `name`, `status`, `created_at`, `confirmed_at`, `risk_free_rate`; `risk` now maps from backend `expected_risk`
- fixed: `frontend/src/types/api.ts` — `HoldingResponse`: added `id`, `portfolio_id`, `instrument_id`, `target_weight`, `actual_weight`, `quantity`, `entry_price`, `entry_date`; `weight` computed as `actual_weight ?? target_weight`
- fixed: `frontend/src/types/api.ts` — `FlagResponse`: added `portfolio_id`, `news_id`, `type`, `status`, `resolved_at`; `category` aliased from `type`; `dismissed` computed from `status`
- fixed: `frontend/src/types/api.ts` — `NewsItemResponse`: added `id`, `materiality_score`, `summary`; `impact` maps from `sentiment`, `impact_level` maps from `level`
- fixed: `frontend/src/types/api.ts` — `ProfileResponse`: `horizon_years` (number) → `horizon` (text: short/medium/long); added `investor_mode`, `capital_pkr`, `constraints`, `questionnaire_answers`, `evaluated_at`
- fixed: `frontend/src/types/api.ts` — `GuestAnalyzeResponse`: `rebalance_actions` widened to `(string | Record<string, unknown>)[]` to match backend `List[Dict]`
- fixed: `frontend/src/components/layout/FlagCard.tsx` — prop renamed from `onDismissed` to `onDismiss` to match Dashboard.tsx usage (was silently not calling the dismiss callback)
- fixed: `frontend/src/pages/Settings.tsx` — `profile.horizon_years` → `profile.horizon` with text label mapping
- fixed: `frontend/src/components/chat/cards/ProfilerCard.tsx` — `horizonLabel(years: number)` → text label from `data.horizon`; removed `data.summary` reference
- fixed: `frontend/src/pages/onboarding/Suggestion.tsx` — curly-quote syntax error in seedMessage string (pre-existing build blocker)

### 2026-06-16 — Phase 6: Frontend full page layer (auth, routing, all 16 pages)
- created: `frontend/src/context/AuthContext.tsx` — `AuthProvider` with `getSession()` + `onAuthStateChange`; POST /auth/session upsert once per session (tracked via `useRef`); exports `useAuth()`
- created: `frontend/src/components/layout/AuthGuard.tsx` — spinner while resolving; `<Navigate to="/login">` if no user; else `<Outlet />`
- created: `frontend/src/components/layout/GuestGuard.tsx` — `<Navigate to="/dashboard">` if user; else `<Outlet />`
- created: `frontend/src/components/layout/AppShell.tsx` — sticky header (wordmark + NavBar top + avatar initials circle); `max-w-5xl` content outlet; mobile bottom tab bar; `getFlags()` on mount for badge count
- created: `frontend/src/components/layout/NavBar.tsx` — top (desktop) + bottom (mobile) variants; jade text + 2px underline for active route; loss-color flag count badge
- created: `frontend/src/components/charts/PerformanceLine.tsx` — Chart.js Line; 2.5px jade stroke; 10% jade fill; mono axes; reduced-motion aware
- created: `frontend/src/components/charts/Sparkline.tsx` — pure SVG 64×24px polyline; jade positive / loss negative; no axes
- edited: `frontend/src/App.tsx` — full lazy route tree: GuestGuard wraps public routes, AuthGuard wraps onboarding (full-screen) + AppShell (core app); `<AuthProvider>` at root; catch-all → /
- created: `frontend/src/pages/Landing.tsx` — hero + 3-feature strip; Sign up (primary jade) + Try (outline) CTAs; no API calls
- created: `frontend/src/pages/Login.tsx` — Supabase signInWithPassword → postSession → /dashboard; inline error; 44px inputs; jade focus rings
- created: `frontend/src/pages/Register.tsx` — Supabase signUp → postSession → /onboarding; carries guestData in location state for post-onboarding surfacing
- created: `frontend/src/pages/onboarding/Questionnaire.tsx` — step-per-question; jade progress bar; single/multi-select + capital PKR input; postQuestionnaire on submit → /onboarding/holdings
- created: `frontend/src/pages/onboarding/DeclareHoldings.tsx` — "Own investments" vs "Start fresh" split; debounced searchMarket dropdown; qty/price/date per row; max 20 rows; declareHoldings → /onboarding/suggestion
- created: `frontend/src/pages/onboarding/Suggestion.tsx` — postSuggest if no state.portfolio; OptimizerCard full-width; Confirm → postConfirm → /dashboard; Adjust → /chat with seed message
- created: `frontend/src/pages/Dashboard.tsx` — portfolio hero (Fraunces value + gain/loss ▲/▼); PerformanceLine; donut + metrics; holdings table (click → /holdings/:symbol); flags preview (max 3); news preview (max 3); DashboardChatDrawer
- created: `frontend/src/pages/News.tsx` — getNewsFeed; All/Direct/Sector/Macro filter pills; impact symbol + Badge; source + date; empty state
- created: `frontend/src/pages/Flags.tsx` — Active/Dismissed tabs with count; FlagCard list; dismissFlag on dismiss action
- created: `frontend/src/pages/HoldingDetail.tsx` — /holdings/:symbol; company header; Overview/Valuation/Technical/News tabs; tab-lazy-loaded ValuationCard + TechnicalCard full-width; news filtered to symbol
- created: `frontend/src/pages/Settings.tsx` — risk profile section (Badge chips + re-take link); account section (email + sign-out); display placeholder
- created: `frontend/src/pages/PortfolioManagement.tsx` — current allocation (donut + stats + holdings list); Re-optimise → reoptimize() → OptimizerCard draft; history placeholder
- created: `frontend/src/pages/GuestAnalyze.tsx` — no-auth holdings form; analyzeGuest() → OptimizerCard + rationale + rebalance; 429 rate-limit banner; "Save & track it" → /register with guestData
- edited: `frontend/src/lib/api.ts` — 10 new typed functions (postSession, getMe, getQuestions, postQuestionnaire, declareHoldings, getPerformance, getDiversification, reoptimize, analyzeGuest, searchMarket)
- edited: `frontend/src/types/api.ts` — 9 new types (UserResponse, QuestionOption, QuestionDefinition, QuestionnaireResponse, DeclareHoldingInput, PerformanceResponse, DiversificationResponse, GuestAnalyzeResponse, InstrumentSearchResult)

### 2026-06-16 — Phase 5: Frontend scaffold + agent conversation UI
- created: `frontend/package.json`, `vite.config.ts`, `tsconfig*.json`, `tailwind.config.js`, `postcss.config.js`, `components.json`, `index.html`, `.env.example` — full Vite + React 18 + TS 5 + Tailwind 3 scaffold; all DESIGN.md §9 tokens + `rose: '#925B6A'` (news card accent)
- created: `frontend/src/main.tsx`, `App.tsx`, `styles/globals.css` — entry point; BrowserRouter; CSS custom properties for all tokens; animation classes; `prefers-reduced-motion` kill-switch; jade focus ring
- created: `frontend/src/lib/utils.ts`, `supabase.ts`, `api.ts` — `cn()` helper; Supabase client; 13 typed API functions with JWT auth headers; `streamChat` SSE reader
- created: `frontend/src/types/chat.ts`, `api.ts` — `AgentRole`, `Message`, `CardData` discriminated union (6 card types), `SSEEvent`; mirrors all backend Pydantic response shapes
- created: `frontend/src/hooks/useReducedMotion.ts`, `useChat.ts` — `matchMedia` listener; streaming message accumulator with `AbortController` cleanup
- created: `frontend/src/components/ui/button.tsx`, `card.tsx`, `badge.tsx`, `sheet.tsx` — hand-written shadcn/ui base components restyled to design tokens; jade focus rings; 44px min touch targets
- created: `frontend/src/components/chat/` (7 files) — `ChatShell`, `MessageList` (empty state + 4 example chips), `UserMessage` (jade-soft, slide-up), `AgentMessage` (card bubble, role label, tool pill), `StreamingIndicator` (3-dot pulse), `ToolRunningPill` (jade arc spin), `Composer` (auto-grow textarea)
- created: `frontend/src/components/chat/cards/` (7 files) — `CardShell` (3px accent bar, mono eyebrow, slide-up); `ProfilerCard`, `OptimizerCard`, `NewsCard`, `RateImpactCard`, `ValuationCard`, `TechnicalCard`, `ChatReplyCard` — all with accessibility requirements (color + symbol, ▲/▼, min 44px, jade focus ring)
- created: `frontend/src/components/charts/` (3 files) — `AllocationDonut` (Chart.js, 68% cutout, AC colors), `MonteCarloRange` (pure SVG, animated current-price marker), `RSIGauge` (SVG semicircle, 3 zones, animated needle)
- created: `frontend/src/pages/Chat.tsx` — history load on mount; flag seed-message bridge via `location.state`; ChatShell fills viewport
- created: `frontend/src/components/layout/DashboardChatDrawer.tsx` — fixed jade trigger; Sheet bottom/right; isolated useChat
- created: `frontend/src/components/layout/FlagCard.tsx` — severity badge + text label; Discuss → /chat bridge; exit animation

### 2026-06-16 — Phase 6: Valuation & Technical Analysis agents
- created: `backend/app/services/valuation.py` — DCF + Monte Carlo + multiples; WACC risk-free = SBP policy rate; all Decimal; returns `insufficient_data` when yfinance has no FCF
- created: `backend/app/services/technical.py` — pure pandas/numpy indicators (RSI/MFI/MACD/SMA/EMA/crossover/support-resistance); DB-first with yfinance fallback; no DB writes
- created: `backend/app/agent/tools/extract_company_info.py`, `run_dcf.py`, `run_monte_carlo.py`, `run_multiples.py`, `run_technical_analysis.py` — 5 thin tool wrappers (tools 11–15)
- created: `backend/app/agent/prompts/valuation_prompt.py`, `technical_prompt.py` — system prompts with ABSTRACTION_GUARDRAIL; no buy/sell/hold directives; daily EOD disclaimer
- created: `backend/app/agent/roles/valuation.py` — `run_valuation()`: symbol extraction, 4 service calls concurrently, LLM task="hard"
- created: `backend/app/agent/roles/technical.py` — `run_technical_analysis_role()`: symbol extraction, indicators, LLM task="reasoning"
- created: `backend/app/api/analysis.py` — 3 read-only endpoints: GET /analysis/company/{symbol}, POST /analysis/valuation/{symbol}, GET /analysis/technical/{symbol}
- edited: `backend/app/agent/orchestrator.py` — added "valuation" + "technical" to `_VALID_INTENTS`, `_CLASSIFY_PROMPT`, `route_intent` dict, LangGraph nodes + edges
- edited: `backend/app/main.py` — mounted `analysis_router`
- edited: `backend/app/agent/tools/__init__.py` — registered 5 new tools; `__all__` updated (10 → 15)
- created: `backend/tests/test_valuation.py` — 6 tests (all passing)
- created: `backend/tests/test_technical.py` — 9 tests (all passing)

### 2026-06-15 — Supabase migration + onboarding questionnaire flow

**Part 1 — Supabase Auth migration:**
- deleted: `backend/create_db.py` — Supabase manages the DB
- edited: `docker-compose.yml` — removed PostgreSQL service; Redis only
- edited: `.env.example` — removed JWT_SECRET; added SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY, SUPABASE_JWT_SECRET
- edited: `backend/requirements.txt` — removed passlib[bcrypt], bcrypt; added supabase==2.15.2
- edited: `backend/app/core/config.py` — removed jwt_* settings; added supabase_url/anon_key/service_key/jwt_secret; DATABASE_URL now points to Supabase PgBouncer
- edited: `backend/app/core/security.py` — replaced entire file: `verify_supabase_jwt()` + updated `get_current_user()`; all bcrypt/minting functions removed
- edited: `backend/app/core/db.py` — switched to `NullPool` for PgBouncer compatibility
- edited: `backend/app/models/user.py` — removed `password_hash`; removed auto-uuid default from `id`
- edited: `backend/app/schemas/auth.py` — removed RegisterRequest/LoginRequest/RefreshRequest/TokenResponse; `UserResponse` only
- edited: `backend/app/api/auth.py` — replaced /register /login /refresh with GET /auth/me + POST /auth/session
- edited: `backend/migrations/env.py` — Alembic now uses `database_url_sync` (direct connection) for DDL
- created: `backend/migrations/versions/001_supabase_migration.py` — drops `password_hash`; removes `id` server default; adds `questionnaire_answers`/`evaluated_at`; enables RLS + policies on 7 tables

**Part 2 — Onboarding questionnaire + holdings declaration:**
- edited: `backend/app/models/risk_profile.py` — added `questionnaire_answers` JSONB + `evaluated_at` TIMESTAMPTZ
- edited: `backend/app/schemas/profile.py` — added `questionnaire_answers` + `evaluated_at` to `ProfileResponse`; removed float json_encoder
- created: `backend/app/schemas/questionnaire.py` — `QuestionDefinition`, `QuestionnaireRequest/Response`, `DeclareHoldingInput/DeclareHoldingsRequest`
- created: `backend/app/services/questionnaire.py` — `QUESTIONS` (5 questions) + `evaluate_questionnaire()` (deterministic mapping)
- edited: `backend/app/api/profile.py` — added GET /profile/questionnaire + POST /profile/questionnaire
- edited: `backend/app/api/portfolio.py` — added POST /declare-holdings (onboarding) + GET /analyze (diversification); fixed Decimal usage; removed float in defaults
- edited: `backend/tests/conftest.py` — configurable TEST_DATABASE_URL; NullPool
- edited: `backend/tests/test_auth.py` — replaced with Supabase JWT verification tests (7 tests); uses ASGITransport
- created: `backend/tests/test_onboarding.py` — 13 tests: question set, evaluate_questionnaire mapping, profile upsert, entry_price NUMERIC, confirmed status, no-float guard, diversification no-writes
- edited: `backend/tests/test_tools.py` — removed `password_hash` from User helpers; added explicit UUIDs
- edited: `backend/tests/test_materiality.py` — removed `password_hash` from User helpers; added explicit UUIDs

### 2026-06-15 — Phase 3 & 4: Agent sub-packages + news scrapers
- created: `backend/app/agent/types.py` — `AgentState` TypedDict
- created: `backend/app/agent/prompts/` (6 files) — `pii_abstraction.py` + 5 role system prompts
- created: `backend/app/agent/roles/` (5 files) — profiler, optimizer, news_materiality, rate_impact, chat
- created: `backend/app/agent/tools/` (11 files) — 10 tool functions + `__init__.py`
- edited: `backend/app/agent/orchestrator.py` — rewritten as proper LangGraph `StateGraph`; flat function replaced with load_context → classify → conditional routing → role nodes
- edited: `backend/app/api/chat.py` — wired to real `AgentOrchestrator`; mock SSE generator removed
- created: `backend/app/data/news/` (6 files) — PSX/SBP/Business Recorder/Dawn scrapers + normalizer + `__init__.py`
- edited: `backend/app/workers/news_monitor.py` — hardcoded mock articles replaced with real scraper pipeline
- created: `backend/tests/test_agent.py` — PII abstraction + no-auto-action tests
- created: `backend/tests/test_tools.py` — per-tool correctness + money-type guard
- created: `backend/tests/test_materiality.py` — direct/sector/macro match + rate-impact flag tests
- edited: `backend/requirements.txt` — added `python-dateutil==2.9.0` (used by normalizer)

### 2026-06-14 — Phases 0–2: Foundation, Data Layer, Portfolio Engine
- created: `docker-compose.yml` — PostgreSQL 15 + Redis containers
- created: `backend/requirements.txt` — core dependency set
- created: `backend/alembic.ini`, `backend/create_db.py` — DB setup tooling
- created: `backend/app/main.py` — FastAPI entry, CORS, health check, lifespan
- created: `backend/app/core/` — config, db, redis, security
- created: `backend/app/models/` — all 11 ORM tables per TECH.md §7
- created: `backend/app/schemas/` — Pydantic v2 schemas for all domains
- created: `backend/app/api/` — auth, profile, portfolio, market, news, chat endpoints
- created: `backend/app/data/adapters/` — yfinance, CoinGecko, SBP, FRED, Alpha Vantage adapters
- created: `backend/app/data/cache.py` — Redis read-through price cache
- created: `backend/app/data/seed.py` — instrument universe seed script
- created: `backend/app/services/` — optimizer, performance, materiality, rate_impact
- created: `backend/app/workers/` — daily_eod, crypto_refresh, tbill_watch, news_monitor (mock)
- created: `backend/migrations/` — Alembic env + template
- created: `backend/tests/` — conftest, test_auth, test_schema, test_adapters, test_optimizer, test_portfolio

### 2026-XX-XX — File structure defined
- created: `STRUCTURE.txt` — ASCII diagram of full project layout
- recorded: file registry populated — specs `done`, backend/frontend `planned`

### 2026-XX-XX — Specs complete, build not started
- created: `TECH.md`, `RULES.md`, `AGENT_RULES.md`, `DESIGN.md`, `FLOW.md` + previews
- Locked: name = Asaas (اثاثہ); LangGraph orchestration; SBP rate as risk-free; crypto legal; flag-don't-auto-act; guest analyze mode persists nothing

---

## 3. Removed files

| File | Removed on | Why |
|---|---|---|
| `backend/create_db.py` | 2026-06-15 | Supabase manages the database; local create-db helper is obsolete |
| `password_hash` column on `users` | 2026-06-15 | Supabase Auth owns credentials; column dropped in migration 001 |
| `bcrypt`, `passlib[bcrypt]` in `requirements.txt` | 2026-06-15 | Replaced by Supabase Auth; no server-side password hashing |
| JWT minting (create_access_token, create_refresh_token) in `security.py` | 2026-06-15 | Supabase issues tokens; backend only verifies them |
| POST /auth/register, /auth/login, /auth/refresh | 2026-06-15 | Replaced by POST /auth/session + Supabase client-side SDK |
| PostgreSQL service in `docker-compose.yml` | 2026-06-15 | Replaced by Supabase cloud DB |
| mock SSE generator in `backend/app/api/chat.py` | 2026-06-15 | Replaced by real `AgentOrchestrator` SSE stream |
| hardcoded `MOCK_NEWS_UPDATES` in `backend/app/workers/news_monitor.py` | 2026-06-15 | Replaced by real scraper pipeline |

---

## 4. Current state summary

_One-paragraph snapshot of where the build stands. Update at each milestone._

> **As of 2026-06-18 (latest):** Full end-to-end codebase audit complete. **29 backend endpoints** across 7 routers + 1 inline health check, all mapped and verified against 25 frontend `api.ts` functions. **1 critical fix**: `searchMarket` query param `?q=` → `?query=` (DeclareHoldings search was silently broken). **Agent chain verified**: orchestrator classifies intent → routes to correct role → tools fire → LLM called with abstracted data → SSE streams → correct card renders. **Data sources live**: yfinance (PSX/global/commodities), CoinGecko (crypto), SBP scrape (policy rate + T-bill/PIB/GIS yields), FRED (macro), AlphaVantage (commodity backup). Read-through cache with per-asset-class TTL (crypto 60s, stocks 4h, T-bills 24h). **APScheduler** with 4 background jobs. Zero hardcoded financial values. **Dead code identified**: `DashboardChatDrawer.tsx` (replaced by DashboardChatComposer), `getMe()` and `getDiversification()` in api.ts (exported but never imported). **Minor notes**: `NewsChat.tsx` uses raw `fetch()` instead of typed `streamChat()`; `PortfolioResponse.concentration_warning` optional field unused by backend; chat history only persists user messages. All 19 adapter/service tests pass.

> **2026-06-26 — Phase A (price backfill):** Added historical OHLCV backfill so analytics read DB-first instead of live-scraping yfinance every request. New `data/adapters/psx_adapter.py` (waterfall: PSX DPS timeseries → `psx-data-reader` → yfinance `.KA`); new history methods `YFinanceAdapter.fetch_history` + `CoinGeckoAdapter.fetch_market_chart` (daily, PKR). New `workers/backfill_prices.py` routes each active instrument by asset class, idempotently upserts 1–2yr daily OHLCV into `prices` (`on_conflict (instrument_id, price_date)`), skips tbill/bond (yields, not prices), and ensures a `^KSE` index instrument for beta/CAPM. Guarded non-blocking startup kick (runs only when `prices` is sparse) + monthly `backfill_prices` scheduler job (now 7 jobs). Added `psx-data-reader` dep + a `DATA_SOURCES` map in `capabilities.py`. Phases B (numpy/scipy optimizer) and C (risk.py + endpoint + dashboard panel) follow.

> **2026-06-26 — Phase B (optimizer rewrite):** Replaced the broken optimizer (it imported `pyptfopt`—a typo—so it *always* fell back to fixed heuristic weights) with a real **numpy/scipy** implementation: aligned daily returns → annualized μ → **Ledoit-Wolf identity-target shrinkage** (closed-form δ, PSD) → SLSQP for **max_sharpe / min_vol / risk_parity** + **HRP** (`scipy.cluster.hierarchy`), plus `efficient_return/efficient_risk/efficient_frontier`. Method selector with per-profile default (`PROFILE_OPTIMIZER_METHOD` registered in `capabilities.py`); keeps crypto/sector caps + heuristic fallback when data is thin; SBP rate = r_f; Decimal at the boundary. Verified on the backfilled DB (all 4 methods sum to 1, caps respected). Spike result: `psx-data-reader` has **no KSE-100 index** → Phase-C beta benchmark will use an **equal-weight PSX-stock composite proxy** (option a).

> **2026-06-26 — Phase C (risk analytics):** New `services/risk.py` (pure-numpy helpers + DB orchestration): historical/parametric **VaR** (95/99), **CVaR**, **max drawdown** + duration, rolling **vol/Sharpe** (30d), **Sortino**, and **beta** vs an equal-weight **PSX-stock composite proxy** (Yahoo `^KSE` delisted, PSX serves no index). Reads the backfilled `prices` table, date-intersects held instruments, weights by current value; every metric carries `value/as_of/source/stale`. New `GET /portfolio/risk` (5-min cache, fail-open) + `RISK_METRICS` scope in `capabilities.py`. `valuation.compute_beta` now uses the DB proxy (`risk.compute_asset_beta`) when a session is passed (analysis endpoint threads `db` through `extract_company_info`) → fixes blank PSX beta (HBL≈0.73 live). Frontend: `getRiskMetrics` + `RiskMetricsResponse` + a Dashboard **Risk** card. Verified: 8 risk + 8 optimizer unit tests, Dashboard 18/18, tsc clean, live DB sanity. **A→B→C complete.** Note: ENGRO's psx-data-reader history ends 2025-01, which currently caps the proxy/portfolio common-date window — re-source ENGRO to extend it.
