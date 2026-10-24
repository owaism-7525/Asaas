"""
Asaas (اثاثہ) — Portfolio API Router

Endpoints for suggesting, confirming, tracking, and declaring portfolios.
Includes guest mode (persists nothing, rate-limited by Redis, RULES.md A2.7).
"""

from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Body, Depends, HTTPException, Request, Response, status
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from redis.asyncio import Redis
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db
from app.core.redis import get_redis
from app.core.security import get_current_user
from app.models.user import User
from app.models.portfolio import Portfolio
from app.models.holding import Holding
from app.models.instrument import Instrument
from app.schemas.portfolio import (
    AddHoldingRequest,
    ConfirmRequest,
    GuestAnalyzeRequest,
    GuestAnalyzeResponse,
    HoldingResponse,
    PortfolioResponse,
    SellHoldingRequest,
    SuggestRequest,
    UpdateHoldingRequest,
)
from app.schemas.questionnaire import DeclareHoldingsRequest
from app.core.response_cache import portfolio_key, get_cached, set_cached, invalidate as invalidate_cache

import logging
logger = logging.getLogger("asaas.api.portfolio")

router = APIRouter(prefix="/portfolio", tags=["portfolio"])


async def _write_initial_snapshot(portfolio_id: UUID) -> None:
    from app.core.db import async_session_factory
    from app.services.performance import PerformanceService
    async with async_session_factory() as bg_db:
        try:
            svc = PerformanceService(bg_db)
            await svc.update_portfolio_metrics(portfolio_id)
        except Exception:
            logger.exception("Initial snapshot failed for portfolio_id=%s", portfolio_id)


@router.post("/analyze-guest", response_model=GuestAnalyzeResponse)
async def analyze_guest(
    request: Request,
    response: Response,
    payload: GuestAnalyzeRequest,
    redis: Redis = Depends(get_redis),
    db: AsyncSession = Depends(get_db),
):
    """
    Analyze guest holdings and suggest optimization without persisting.
    Rate-limited by browser cookie (soft UX check) + Redis IP counter (hard backstop).
    Fetches real prices, runs optimizer, returns genuine analysis.
    """
    import asyncio
    from app.data.cache import get_prices
    from app.services.optimizer import PortfolioOptimizer, expected_return_for_class
    from app.core.market import get_usd_pkr_rate, get_sbp_rate
    from app.data.adapters.yfinance_adapter import YFinanceAdapter
    from app.data.adapters.coingecko_adapter import CoinGeckoAdapter
    from sqlalchemy import select as sa_select
    from app.models.instrument import Instrument
    from datetime import date as date_type

    client_ip = request.client.host if request.client else "unknown"
    ip_key = f"rate_limit:guest_ip:{client_ip}"
    ip_runs = await redis.get(ip_key)
    if ip_runs and int(ip_runs) >= 5:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Quota exceeded. Please sign up to analyze more portfolios.",
        )

    cookie_runs_str = request.cookies.get("guest_runs_count", "0")
    try:
        cookie_runs = int(cookie_runs_str)
    except ValueError:
        cookie_runs = 0

    if cookie_runs >= 5:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Free guest limit reached. Please register to continue.",
        )

    await redis.incr(ip_key)
    await redis.expire(ip_key, 86400)

    response.set_cookie(
        key="guest_runs_count",
        value=str(cookie_runs + 1),
        max_age=86400,
        httponly=True,
        samesite="lax",
    )

    # Fetch shared rates once — no hardcoded USD/PKR anywhere below
    usd_pkr, sbp_rate = await asyncio.gather(get_usd_pkr_rate(), get_sbp_rate())  # sbp_rate: Decimal e.g. 0.20 for 20%

    # One concurrent price fetch for every market-priced holding (tbill/bond are
    # valued from their own rate, not a market price).
    prices = await get_prices([
        h.symbol.strip() for h in payload.holdings
        if h.asset_class in ("equity", "crypto", "commodity")
    ])

    holdings_data = []
    total_value = Decimal("0")
    total_cost = Decimal("0")
    asset_classes: dict = {}
    sectors: dict = {}

    for h in payload.holdings:
        symbol = h.symbol.upper().strip()
        ac = h.asset_class  # authoritative from request, NOT from instruments table

        # Name/sector lookup — informational only, never 404
        inst_result = await db.execute(
            sa_select(Instrument).where(Instrument.symbol == symbol)
        )
        instrument = inst_result.scalar_one_or_none()
        name = instrument.name if instrument else symbol
        sector = instrument.sector if instrument else "Unknown"

        current_value_pkr: Decimal
        cost_basis_pkr: Decimal

        if ac == "equity":
            price_pkr = prices.get(symbol)
            if price_pkr is None:
                try:
                    r = await YFinanceAdapter(max_retries=1).fetch_price(symbol)
                    price_pkr = Decimal(str(r["price"])) if r and r.get("price") is not None else None
                except Exception:
                    price_pkr = None
            if price_pkr is None:
                continue
            cost_basis_pkr = h.qty * h.entry_price
            current_value_pkr = h.qty * price_pkr

        elif ac in ("tbill", "bond"):
            cost_basis_pkr = h.entry_price  # actual buying price (may be < face value for discounted T-bills)
            if h.buy_date:
                days = (date_type.today() - h.buy_date).days
                rate = h.interest_rate_at_buy or Decimal("0")
                current_value_pkr = h.qty * (1 + (rate / 100) * Decimal(str(days)) / 365)
            else:
                current_value_pkr = h.qty  # face value if no buy date provided

        elif ac == "crypto":
            price_usd = prices.get(symbol)
            if price_usd is None:
                try:
                    cg_prices = await CoinGeckoAdapter().fetch_prices([symbol])
                    price_usd = cg_prices.get(symbol)
                except Exception:
                    price_usd = None
            if price_usd is None:
                continue
            cost_basis_pkr = h.qty * h.entry_price   # user entered PKR/unit
            current_value_pkr = h.qty * price_usd * usd_pkr

        elif ac == "commodity":
            price_usd_oz = prices.get(symbol)
            if price_usd_oz is None:
                try:
                    r = await YFinanceAdapter(max_retries=1).fetch_price(symbol)
                    price_usd_oz = Decimal(str(r["price"])) if r and r.get("price") is not None else None
                except Exception:
                    price_usd_oz = None
            if price_usd_oz is None:
                continue
            tola_to_oz = Decimal("0.375")
            cost_basis_pkr = h.qty * h.entry_price         # tola × Rs/tola = Rs
            current_value_pkr = h.qty * tola_to_oz * price_usd_oz * usd_pkr

        else:
            continue

        pnl_pct = (
            (current_value_pkr - cost_basis_pkr) / cost_basis_pkr * 100
            if cost_basis_pkr > 0 else Decimal("0")
        )
        total_value += current_value_pkr
        total_cost += cost_basis_pkr

        holdings_data.append({
            "symbol": symbol,
            "name": name,
            "asset_class": ac,
            "sector": sector,
            "qty": h.qty,
            "entry_price": h.entry_price,
            "interest_rate_at_buy": h.interest_rate_at_buy,
            "buy_date": h.buy_date,
            "current_value_pkr": current_value_pkr,
            "cost_basis_pkr": cost_basis_pkr,
            "pnl_pct": pnl_pct,
        })
        asset_classes[symbol] = ac
        sectors[symbol] = sector

    if not holdings_data or total_value == 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Could not resolve prices for any holdings. Check symbols and try again.",
        )

    # Weights derived from current_value_pkr
    current_weights: dict = {}
    concentration_warnings = []

    for h in holdings_data:
        weight = h["current_value_pkr"] / total_value
        current_weights[h["symbol"]] = weight
        if weight > Decimal("0.30"):
            concentration_warnings.append(
                f"{h['symbol']} is {weight*100:.1f}% of your portfolio (>30% concentration)"
            )

    ac_counts: dict = {}
    for h in holdings_data:
        ac_counts[h["asset_class"]] = ac_counts.get(h["asset_class"], 0) + 1

    diversification_score = min(len(ac_counts) / 4, 1.0)

    total_pnl_pct = (
        (total_value - total_cost) / total_cost * 100
        if total_cost > 0 else Decimal("0")
    )
    holdings_detail = [
        {
            "symbol": h["symbol"],
            "asset_class": h["asset_class"],
            "current_weight": round(float(current_weights[h["symbol"]]), 4),
            "pnl_pct": round(float(h["pnl_pct"]), 2),
        }
        for h in holdings_data
    ]

    current_metrics = {
        "num_holdings": len(holdings_data),
        "asset_classes": ac_counts,
        "diversification_score": round(diversification_score, 2),
        "concentration_warnings": concentration_warnings,
        "weights": {k: round(float(v), 4) for k, v in current_weights.items()},
        "symbol_classes": {h["symbol"]: h["asset_class"] for h in holdings_data},
        "total_pnl_pct": round(float(total_pnl_pct), 2),
        "holdings_detail": holdings_detail,
    }

    optimizer = PortfolioOptimizer(risk_free_rate=sbp_rate)
    suggested_weights = optimizer._generate_heuristic_allocation(
        symbols=list(current_weights.keys()),
        asset_classes=asset_classes,
        risk_tolerance=payload.risk_tolerance,
    )

    # Per-class expected returns replace the hardcoded 12%
    symbol_mu = {
        sym: expected_return_for_class(asset_classes.get(sym, "equity"), sbp_rate)
        for sym in suggested_weights.keys()
    }
    w_total = sum(suggested_weights.values()) or Decimal("1")
    expected_return = sum(
        symbol_mu[sym] * w for sym, w in suggested_weights.items()
    )
    expected_risk = Decimal("0.10")
    sharpe = (expected_return - sbp_rate) / expected_risk if expected_risk > 0 else Decimal("1.0")

    suggested_holdings = []
    for symbol, weight in suggested_weights.items():
        if weight <= 0:
            continue
        orig = next((h for h in holdings_data if h["symbol"] == symbol), None)
        if orig:
            suggested_holdings.append({
                "symbol": symbol,
                "name": orig["name"],
                "asset_class": orig["asset_class"],
                "weight": float(weight),
            })

    null_uuid = UUID("00000000-0000-0000-0000-000000000000")
    suggested_portfolio = PortfolioResponse(
        id=null_uuid,
        user_id=null_uuid,
        name="Suggested Guest Portfolio",
        status="draft",
        expected_return=expected_return,
        expected_risk=expected_risk,
        sharpe=sharpe,
        risk_free_rate=sbp_rate,
        rationale=f"Optimised for {payload.risk_tolerance} risk tolerance with {len(suggested_holdings)} holdings across {len(ac_counts)} asset classes.",
        created_at=datetime.now(timezone.utc),
        holdings=[
            HoldingResponse(
                id=null_uuid,
                portfolio_id=null_uuid,
                instrument_id=null_uuid,
                symbol=h["symbol"],
                name=h["name"],
                asset_class=h["asset_class"],
                target_weight=Decimal(str(h["weight"])),
            )
            for h in suggested_holdings
        ],
    )

    rebalance_actions = []
    for h in holdings_data:
        sym = h["symbol"]
        old_w = current_weights.get(sym, Decimal("0"))
        new_w = suggested_weights.get(sym, Decimal("0"))
        diff = new_w - old_w
        if abs(diff) < Decimal("0.01"):
            continue
        direction = "Increase" if diff > 0 else "Decrease"
        unit = "tola" if h["asset_class"] == "commodity" else "shares" if h["asset_class"] == "equity" else "units"
        rebalance_actions.append(
            f"{direction} {h['qty']} {unit} {sym} from {old_w*100:.1f}% to {new_w*100:.1f}% "
            f"({'+'if diff>0 else ''}{diff*100:.1f}pp)"
        )

    all_acs = {"equity": "PSX stocks", "crypto": "Crypto", "tbill": "T-bills", "commodity": "Commodities"}
    for ac, label in all_acs.items():
        if ac not in ac_counts:
            rebalance_actions.append(f"Consider adding {label} for diversification")

    # T-Bill/Bond yield vs SBP rate comparison + discount note
    sbp_pct = sbp_rate * 100
    for h in holdings_data:
        if h["asset_class"] in ("tbill", "bond") and h["interest_rate_at_buy"]:
            face_value = h["qty"]
            buy_price = h["cost_basis_pkr"]   # entry_price — actual amount paid
            locked = float(h["interest_rate_at_buy"])
            spread_bps = round((locked - float(sbp_pct)) * 100)

            # Discount note: if bought below face value, effective yield > stated rate
            if buy_price < face_value and face_value > 0:
                discount_pct = float((face_value - buy_price) / face_value * 100)
                rebalance_actions.append(
                    f"{h['symbol']}: purchased at a {discount_pct:.1f}% discount to face value. "
                    f"Your effective yield is higher than the stated {locked:.2f}% coupon rate."
                )

            if spread_bps > 0:
                rebalance_actions.append(
                    f"{h['symbol']}: locked at {locked:.2f}% vs SBP {float(sbp_pct):.2f}% "
                    f"(+{spread_bps} bps premium). Consider holding to maturity."
                )
            elif spread_bps < 0:
                rebalance_actions.append(
                    f"{h['symbol']}: locked at {locked:.2f}% vs SBP {float(sbp_pct):.2f}% "
                    f"({spread_bps} bps). New T-bills offer a better rate — consider at maturity."
                )
            else:
                rebalance_actions.append(
                    f"{h['symbol']}: locked yield matches current SBP rate ({float(sbp_pct):.2f}%)."
                )

    parts = []
    if concentration_warnings:
        parts.append(f"Your portfolio has concentration risk: {'; '.join(concentration_warnings[:2])}.")
    if len(ac_counts) < 3:
        parts.append(f"Only {len(ac_counts)} asset class(es) — adding diversification would reduce risk.")
    if not parts:
        parts.append("Your portfolio has reasonable diversification.")
    parts.append(
        f"The suggested allocation targets {payload.risk_tolerance} risk with "
        f"an expected Sharpe ratio of {float(sharpe):.2f} (risk-free rate: {float(sbp_pct):.2f}%)."
    )

    return GuestAnalyzeResponse(
        current_metrics=current_metrics,
        suggested_portfolio=suggested_portfolio,
        rationale=" ".join(parts),
        rebalance_actions=rebalance_actions[:10],
    )


@router.post("/suggest", response_model=PortfolioResponse)
async def suggest_portfolio(
    payload: SuggestRequest = Body(default_factory=SuggestRequest),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Build an actual portfolio with holdings based on the user's risk profile."""
    from app.data.adapters.sbp_adapter import SBPAdapter
    from app.services.optimizer import PortfolioOptimizer, is_valid_candidate
    from app.models.instrument import Instrument
    from sqlalchemy.orm import selectinload

    risk_free = Decimal("0.115")
    try:
        # Use the shared resolver (cache → live → last-known-good) so a transient
        # scrape failure falls back to the most recent real rate, not a constant.
        from app.core.market import get_sbp_rate
        risk_free = await get_sbp_rate()
    except Exception:
        pass

    from app.models.risk_profile import RiskProfile
    result = await db.execute(
        select(RiskProfile).where(RiskProfile.user_id == current_user.id)
    )
    profile = result.scalar_one_or_none()

    risk_tolerance = payload.risk_tolerance or (profile.risk_tolerance if profile else "moderate")
    capital = payload.initial_capital or (profile.initial_capital if profile else Decimal("100000"))

    inst_result = await db.execute(
        select(Instrument).where(Instrument.is_active == True)
    )
    all_instruments = [i for i in inst_result.scalars().all() if is_valid_candidate(i)]

    instrument_map = {i.symbol: i for i in all_instruments}
    asset_classes = {i.symbol: i.asset_class for i in all_instruments}
    sectors = {i.symbol: (i.sector or "Unknown") for i in all_instruments}

    default_symbols = {
        "psx_stock": ["HBL", "UBL", "OGDC", "EFERT", "LUCK"],
        "crypto": ["BTC", "ETH"],
        "commodity": ["GC=F", "SI=F"],
        "tbill": [],
    }

    tbill_insts = [i for i in all_instruments if i.asset_class == "tbill"]
    if tbill_insts:
        default_symbols["tbill"] = [i.symbol for i in tbill_insts[:2]]

    selected = []
    for ac, syms in default_symbols.items():
        for s in syms:
            if s in instrument_map:
                selected.append(s)

    if not selected:
        selected = list(instrument_map.keys())[:10]

    # Check for existing confirmed (declared) holdings and seed the optimizer with them
    has_existing_holdings = False
    declared_res = await db.execute(
        select(Portfolio)
        .options(selectinload(Portfolio.holdings))
        .where(Portfolio.user_id == current_user.id, Portfolio.status == "confirmed")
        .order_by(Portfolio.confirmed_at.desc())
    )
    declared_portfolio = declared_res.scalars().first()
    if declared_portfolio and declared_portfolio.holdings:
        has_existing_holdings = True
        declared_syms = []
        for dh in declared_portfolio.holdings:
            inst_r = await db.execute(
                select(Instrument).where(Instrument.id == dh.instrument_id)
            )
            di = inst_r.scalar_one_or_none()
            if di and di.symbol in instrument_map:
                declared_syms.append(di.symbol)
        if declared_syms:
            selected = list(dict.fromkeys(declared_syms + selected))

    # --- Real optimization on DB price history (Phase B), not the heuristic. ---
    from app.models.price import Price
    from app.services.optimizer import (
        aligned_returns, mean_historical_return, ledoit_wolf_cov, expected_return_for_class,
    )
    from app.core.capabilities import PROFILE_OPTIMIZER_METHOD
    import numpy as np

    WINDOW = 180
    historical_prices: "dict[str, list[Decimal]]" = {}
    for sym in selected:
        inst = instrument_map.get(sym)
        if inst is None:
            continue
        if inst.asset_class in ("tbill", "bond"):
            # T-bills have no market price series; model a held bill as accreting
            # at the SBP rate — constant daily return ≈ yield, ~0 volatility. This
            # is the correct risk-free representation, so conservative profiles can
            # still allocate to bonds (not fabrication: a held bill returns its yield).
            daily = 1 + float(risk_free) / 252
            series = [Decimal(str(round(100 * daily ** t, 6))) for t in range(WINDOW)]
            historical_prices[sym] = list(reversed(series))  # DESC, like the DB lists
            continue
        rows = (await db.execute(
            select(Price.price).where(Price.instrument_id == inst.id)
            .order_by(Price.price_date.desc()).limit(WINDOW)
        )).fetchall()
        if len(rows) >= 2:
            historical_prices[sym] = [Decimal(str(r[0])) for r in rows]

    optimizer = PortfolioOptimizer(risk_free_rate=risk_free)
    method = PROFILE_OPTIMIZER_METHOD.get(risk_tolerance, "max_sharpe")
    weights = optimizer.optimize(
        historical_prices=historical_prices,
        asset_classes=asset_classes,
        sectors=sectors,
        risk_tolerance=risk_tolerance,
        method=method,
    )

    # Real expected return / risk / Sharpe from μ and the Ledoit-Wolf shrunk Σ.
    exp_ret = exp_risk = sharpe = None
    syms_h, rets = aligned_returns(historical_prices)
    if rets is not None and len(syms_h) >= 2:
        mu = mean_historical_return(rets)
        cov = ledoit_wolf_cov(rets)
        w = np.array([float(weights.get(s, 0)) for s in syms_h])
        if w.sum() > 0:
            w = w / w.sum()
            pr = float(w @ mu)
            pv = float(np.sqrt(max(float(w @ cov @ w), 0.0)))
            exp_ret = Decimal(str(round(pr, 4)))
            exp_risk = Decimal(str(round(pv, 4)))
            sharpe = Decimal(str(round((pr - float(risk_free)) / pv, 2))) if pv > 0 else Decimal("0")
    if exp_ret is None:
        # Thin-data fallback: class-proxy weighted expected return (honest estimate).
        exp_ret = sum(
            (weights.get(s, Decimal("0")) * expected_return_for_class(asset_classes.get(s, "equity"), risk_free)
             for s in weights), Decimal("0"),
        )
        exp_risk = Decimal("0.10")
        sharpe = (exp_ret - risk_free) / exp_risk if exp_risk > 0 else Decimal("0")

    draft_portfolio = Portfolio(
        user_id=current_user.id,
        name=f"Suggested Portfolio — {risk_tolerance.title()}",
        status="draft",
        expected_return=exp_ret,
        expected_risk=exp_risk,
        sharpe=sharpe,
        risk_free_rate=risk_free,
        rationale=f"{method.replace('_', ' ').title()}-optimised {risk_tolerance} portfolio with ₨{capital:,.0f} across {len([w for w in weights.values() if w > 0])} holdings.",
    )
    db.add(draft_portfolio)
    await db.flush()

    from app.data.cache import get_prices
    held = [s for s, w in weights.items() if w > 0 and s in instrument_map]
    prices = await get_prices(held, db) if held else {}

    for symbol, weight in weights.items():
        if weight <= 0 or symbol not in instrument_map:
            continue
        inst = instrument_map[symbol]
        price = prices.get(symbol.upper())
        if price is None:
            price = Decimal("100")
        qty = (capital * weight) / price
        holding = Holding(
            portfolio_id=draft_portfolio.id,
            instrument_id=inst.id,
            actual_weight=float(weight),
            quantity=qty,
            entry_price=price,
            entry_date=datetime.now(timezone.utc).date(),
        )
        db.add(holding)

    await db.commit()
    await db.refresh(draft_portfolio)

    # Compute concentration warning (schema-only field, not persisted)
    conc_warn = None
    for sym, w in weights.items():
        if float(w) > 0.30:
            conc_warn = f"{sym} is {float(w)*100:.0f}% of your portfolio (>30% — high concentration risk)"
            break
    draft_portfolio.concentration_warning = conc_warn
    draft_portfolio.has_existing_holdings = has_existing_holdings

    return draft_portfolio


@router.post("/confirm", response_model=PortfolioResponse)
async def confirm_portfolio(
    payload: ConfirmRequest,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Confirm actual holdings for the user's draft portfolio. Transitions status to 'confirmed'."""
    result = await db.execute(
        select(Portfolio)
        .where(Portfolio.user_id == current_user.id, Portfolio.status == "draft")
        .order_by(Portfolio.created_at.desc())
    )
    portfolio = result.scalars().first()

    if not portfolio:
        # Idempotent: if already confirmed (e.g., came from declare-holdings path), return it as-is
        conf_result = await db.execute(
            select(Portfolio)
            .where(Portfolio.user_id == current_user.id, Portfolio.status == "confirmed")
            .order_by(Portfolio.confirmed_at.desc())
            .limit(1)
        )
        existing = conf_result.scalar_one_or_none()
        if existing:
            return existing
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No portfolio to confirm. Generate a suggestion first.",
        )

    for h in payload.holdings:
        holding = Holding(
            portfolio_id=portfolio.id,
            instrument_id=h.instrument_id,
            actual_weight=h.actual_weight,
            quantity=h.quantity,
            entry_price=h.entry_price,
            entry_date=h.entry_date or datetime.now(timezone.utc).date(),
        )
        db.add(holding)

    portfolio.status = "confirmed"
    portfolio.confirmed_at = datetime.now(timezone.utc)

    await db.commit()
    await db.refresh(portfolio)
    background_tasks.add_task(_write_initial_snapshot, portfolio.id)
    from app.workers.warm_prices import run_warm_prices
    background_tasks.add_task(run_warm_prices)  # warm newly-confirmed holdings
    await invalidate_cache(portfolio_key(current_user.id))
    return portfolio


@router.post(
    "/declare-holdings",
    response_model=PortfolioResponse,
    status_code=status.HTTP_201_CREATED,
)
async def declare_holdings(
    payload: DeclareHoldingsRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Declare existing holdings the user already owns (onboarding step)."""
    portfolio = Portfolio(
        user_id=current_user.id,
        name="Existing Holdings",
        status="confirmed",
        rationale="User-declared existing positions captured during onboarding.",
        confirmed_at=datetime.now(timezone.utc),
    )
    db.add(portfolio)
    await db.flush()

    for h in payload.holdings:
        entry_date: date = date.today()
        if h.entry_date:
            try:
                entry_date = date.fromisoformat(h.entry_date)
            except ValueError:
                pass

        holding = Holding(
            portfolio_id=portfolio.id,
            instrument_id=h.instrument_id,
            quantity=Decimal(str(h.quantity)),
            entry_price=Decimal(str(h.entry_price)),
            entry_date=entry_date,
            actual_weight=Decimal("0"),
        )
        db.add(holding)

    await db.commit()
    await db.refresh(portfolio)
    await invalidate_cache(portfolio_key(current_user.id))
    return portfolio


@router.get("/analyze")
async def analyze_portfolio(
    portfolio_id: Optional[UUID] = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Analyze a portfolio's diversification (read-only)."""
    from app.agent.tools.check_diversification import check_diversification

    if portfolio_id is None:
        result = await db.execute(
            select(Portfolio)
            .where(Portfolio.user_id == current_user.id, Portfolio.status == "confirmed")
            .order_by(Portfolio.confirmed_at.desc())
        )
        portfolio = result.scalars().first()
        if not portfolio:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="No confirmed portfolio found. Declare holdings first.",
            )
        portfolio_id = portfolio.id
    else:
        result = await db.execute(
            select(Portfolio).where(Portfolio.id == portfolio_id)
        )
        portfolio = result.scalar_one_or_none()
        if not portfolio or portfolio.user_id != current_user.id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Portfolio not found or not authorized.",
            )

    return await check_diversification(db=db, portfolio_id=portfolio_id)


async def _holdings_with_prices(holdings: list[Holding], db: AsyncSession) -> list[HoldingResponse]:
    """Serialize holdings with their current market price attached."""
    from app.data.cache import get_prices

    symbols = [h.symbol for h in holdings if h.symbol]
    prices = await get_prices(symbols, db) if symbols else {}
    out = []
    for h in holdings:
        resp = HoldingResponse.model_validate(h)
        if h.symbol:
            resp.current_price = prices.get(h.symbol.upper())
        out.append(resp)
    return out


async def _load_active_portfolio(current_user: User, db: AsyncSession) -> Portfolio:
    """Load the user's active (non-draft) portfolio ORM object, or raise 404.

    Internal helper (returns the ORM object) used by get_holdings and the
    activity endpoints — kept separate from the cached HTTP endpoint below so
    callers that need the ORM object aren't handed a JSONResponse.
    """
    result = await db.execute(
        select(Portfolio)
        .where(Portfolio.user_id == current_user.id, Portfolio.status != "draft")
        .order_by(Portfolio.confirmed_at.desc())
    )
    portfolio = result.scalars().first()
    if not portfolio:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No active portfolio found.",
        )
    return portfolio


@router.get("", response_model=PortfolioResponse)
async def get_portfolio(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get the active portfolio (cached 30s per user; invalidated on changes)."""
    key = portfolio_key(current_user.id)
    cached = await get_cached(key)
    if cached is not None:
        return JSONResponse(content=cached)

    portfolio = await _load_active_portfolio(current_user, db)
    response = PortfolioResponse.model_validate(portfolio)
    response.holdings = await _holdings_with_prices(portfolio.holdings, db)
    payload = jsonable_encoder(response)
    await set_cached(key, payload, 30)
    return JSONResponse(content=payload)


@router.get("/holdings", response_model=list[HoldingResponse])
async def get_holdings(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List current user's holdings, each with its current market price."""
    portfolio = await _load_active_portfolio(current_user, db)
    return await _holdings_with_prices(portfolio.holdings, db)


def round_quantity(qty: Decimal, asset_class: Optional[str]) -> Decimal:
    """Order-entry rounding by asset class: stocks trade in whole shares, funds
    to 2 dp, bonds/T-bills to 4 dp; crypto/commodity stay fractional. Applied to
    NEW orders only — existing fractional holdings are left untouched."""
    ac = (asset_class or "").lower()
    if ac in ("equity", "psx_stock", "global_stock", "stock"):
        return Decimal(int(qty))  # floor to whole shares
    if ac in ("fund", "etf", "mutual_fund"):
        return qty.quantize(Decimal("0.01"))
    if ac in ("bond", "tbill", "debt", "sukuk"):
        return qty.quantize(Decimal("0.0001"))
    return qty  # crypto / commodity — fractional allowed


async def _recompute_weights(portfolio: Portfolio, db: AsyncSession) -> Optional[str]:
    """Recompute each holding's actual_weight from current market value so the
    weights reflect reality after a buy/sell, and return a concentration warning
    when any single sector exceeds 25% of portfolio value."""
    from app.data.cache import get_prices
    from app.models.instrument import Instrument

    rows = (await db.execute(
        select(Holding, Instrument).join(Instrument, Instrument.id == Holding.instrument_id)
        .where(Holding.portfolio_id == portfolio.id)
    )).all()
    if not rows:
        return None

    try:
        prices = await get_prices([inst.symbol for _, inst in rows], db)
    except Exception:
        prices = {}

    valued: list[tuple[Holding, str, Decimal]] = []
    total = Decimal("0")
    for h, inst in rows:
        price = prices.get(inst.symbol.upper())
        val = (Decimal(str(price)) * (h.quantity or Decimal("0"))) if price else Decimal("0")
        valued.append((h, inst.sector or "Unknown", val))
        total += val

    if total <= 0:
        return None

    sector_totals: dict[str, Decimal] = {}
    for h, sector, val in valued:
        h.actual_weight = val / total
        sector_totals[sector] = sector_totals.get(sector, Decimal("0")) + val
    await db.commit()

    worst = max(sector_totals.items(), key=lambda kv: kv[1], default=None)
    if worst:
        pct = worst[1] / total * 100
        if pct > 25:
            return (
                f"{worst[0]} is {pct:.0f}% of your portfolio (>25% concentration). "
                "Consider diversifying."
            )
    return None


@router.post("/holdings/add", response_model=PortfolioResponse, status_code=status.HTTP_201_CREATED)
async def add_holding(
    payload: AddHoldingRequest,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """'I bought' — add a holding to the user's confirmed portfolio."""
    from app.services.instrument_resolver import resolve_instrument

    portfolio = await _load_active_portfolio(current_user, db)  # 404 if no active portfolio

    inst = await resolve_instrument(
        payload.symbol, db, asset_class=payload.asset_class, name=payload.name
    )
    if not inst:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Instrument '{payload.symbol}' not found.",
        )

    # Order-entry rounding by asset class (stocks → whole shares, etc.).
    qty = round_quantity(payload.quantity, inst.asset_class)
    if qty <= 0:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"Order for {payload.symbol} rounds to 0 units — stocks trade in "
                "whole shares. Increase the quantity to at least 1."
            ),
        )

    holding = Holding(
        portfolio_id=portfolio.id,
        instrument_id=inst.id,
        quantity=qty,
        entry_price=payload.entry_price,
        entry_date=payload.entry_date or datetime.now(timezone.utc).date(),
        actual_weight=Decimal("0"),
    )
    db.add(holding)
    await db.flush()  # assign holding.id so the ledger row can reference it

    from app.services.wallet import InsufficientFundsError, debit_cash

    cost = (qty * payload.entry_price).quantize(Decimal("0.01"))
    try:
        await debit_cash(
            db,
            current_user.id,
            cost,
            txn_type="buy",
            holding_id=holding.id,
            symbol=inst.symbol,
            quantity=qty,
            price=payload.entry_price,
        )
    except InsufficientFundsError as e:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"Insufficient funds: this order costs ₨{cost:,.2f} but your cash "
                f"balance is ₨{e.balance:,.2f}. Deposit cash to continue."
            ),
        )
    await db.commit()
    background_tasks.add_task(_write_initial_snapshot, portfolio.id)
    from app.workers.warm_prices import run_warm_prices
    background_tasks.add_task(run_warm_prices)  # warm the just-added instrument
    await invalidate_cache(portfolio_key(current_user.id))
    warning = await _recompute_weights(portfolio, db)
    result = await _load_active_portfolio(current_user, db)
    result.concentration_warning = warning
    return result


@router.post("/holdings/sell", response_model=PortfolioResponse)
async def sell_holding(
    payload: SellHoldingRequest,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """'I sold' — reduce or remove an existing holding."""
    portfolio = await _load_active_portfolio(current_user, db)

    res = await db.execute(
        select(Holding).where(
            Holding.id == payload.holding_id,
            Holding.portfolio_id == portfolio.id,
        )
    )
    holding = res.scalar_one_or_none()
    if not holding:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Holding not found in your portfolio.",
        )

    held = holding.quantity or Decimal("0")
    if payload.quantity > held:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Insufficient holdings.",
        )

    # Capture instrument symbol before a possible full-liquidation delete.
    inst_res = await db.execute(select(Instrument).where(Instrument.id == holding.instrument_id))
    sold_instrument = inst_res.scalar_one_or_none()
    sold_symbol = sold_instrument.symbol if sold_instrument else None

    full_liquidation = payload.quantity == held
    if full_liquidation:
        await db.delete(holding)
    else:
        holding.quantity = held - payload.quantity

    from app.services.wallet import credit_cash

    proceeds = (payload.quantity * payload.price).quantize(Decimal("0.01"))
    await credit_cash(
        db,
        current_user.id,
        proceeds,
        txn_type="sell",
        holding_id=None if full_liquidation else holding.id,
        symbol=sold_symbol,
        quantity=payload.quantity,
        price=payload.price,
    )

    await db.commit()
    background_tasks.add_task(_write_initial_snapshot, portfolio.id)
    await invalidate_cache(portfolio_key(current_user.id))
    warning = await _recompute_weights(portfolio, db)
    result = await _load_active_portfolio(current_user, db)
    result.concentration_warning = warning
    return result


@router.put("/holdings/{holding_id}", response_model=PortfolioResponse)
async def update_holding(
    holding_id: UUID,
    payload: UpdateHoldingRequest,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """'Update price' — set a new entry price on an existing holding."""
    portfolio = await _load_active_portfolio(current_user, db)

    res = await db.execute(
        select(Holding).where(
            Holding.id == holding_id,
            Holding.portfolio_id == portfolio.id,
        )
    )
    holding = res.scalar_one_or_none()
    if not holding:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Holding not found in your portfolio.",
        )

    holding.entry_price = payload.entry_price
    await db.commit()
    background_tasks.add_task(_write_initial_snapshot, portfolio.id)
    await invalidate_cache(portfolio_key(current_user.id))
    return await _load_active_portfolio(current_user, db)


@router.post("/reoptimize", response_model=PortfolioResponse)
async def reoptimize_portfolio(
    flag_id: Optional[UUID] = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Reoptimize current portfolio, optionally referencing a flag. Returns a new draft."""
    return await suggest_portfolio(SuggestRequest(), current_user, db)


@router.get("/performance")
async def get_performance(
    background_tasks: BackgroundTasks,
    live: bool = False,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """P&L from entry prices vs current prices across all confirmed holdings.

    Stale-while-revalidate (default): serve the last PortfolioSnapshot's totals +
    history instantly with ``stale: true`` and kick a background recompute; the
    client then re-fetches ``?live=true`` to flip to the full live figures
    (including per-holding performance, which snapshots don't store). ``live=true``
    skips the snapshot and computes live directly.

    No computed value changes: the live figures are byte-identical to before, and
    the snapshot served on the fast path is the same value the history chart
    already shows. (Note: the snapshot is FX-converted by the EOD/metrics writer
    while the live path is not, so for USD-instrument holdings the figure can
    shift slightly on the live flip — a pre-existing difference, not introduced
    here.)
    """
    from decimal import Decimal
    from app.data.cache import get_prices
    from app.models.instrument import Instrument
    from app.models.snapshot import PortfolioSnapshot
    from sqlalchemy import asc

    port_res = await db.execute(
        select(Portfolio)
        .where(Portfolio.user_id == current_user.id, Portfolio.status == "confirmed")
        .order_by(Portfolio.confirmed_at.desc())
    )
    portfolio = port_res.scalars().first()
    if not portfolio:
        return {"pnl_absolute": "0", "pnl_percent": "0", "history": [], "holdings_performance": [], "stale": False}

    async def _snapshot_history():
        snaps_res = await db.execute(
            select(PortfolioSnapshot)
            .where(PortfolioSnapshot.portfolio_id == portfolio.id)
            .order_by(asc(PortfolioSnapshot.snapshot_date))
        )
        return [
            {"date": str(s.snapshot_date), "value": str(s.total_value_pkr), "pnl_pct": str(s.pnl_percent or "0")}
            for s in snaps_res.scalars().all()
        ]

    # Stale-while-revalidate: serve the last snapshot instantly, recompute in the
    # background. The client re-fetches ?live=true to flip to live figures.
    if not live:
        snap = (await db.execute(
            select(PortfolioSnapshot)
            .where(PortfolioSnapshot.portfolio_id == portfolio.id)
            .order_by(PortfolioSnapshot.snapshot_date.desc())
        )).scalars().first()
        if snap is not None:
            background_tasks.add_task(_write_initial_snapshot, portfolio.id)
            return {
                "pnl_absolute": str(Decimal(str(snap.pnl_absolute or 0)).quantize(Decimal("0.01"))),
                "pnl_percent": str(Decimal(str(snap.pnl_percent or 0)).quantize(Decimal("0.0001"))),
                "total_value": str(Decimal(str(snap.total_value_pkr or 0)).quantize(Decimal("0.01"))),
                "history": await _snapshot_history(),
                "holdings_performance": [],
                "stale": True,
                "as_of": str(snap.snapshot_date),
            }
        # No snapshot yet → fall through to a live compute (which also creates one).

    hold_res = await db.execute(
        select(Holding).where(Holding.portfolio_id == portfolio.id)
    )
    holdings = hold_res.scalars().all()
    if not holdings:
        return {"pnl_absolute": "0", "pnl_percent": "0", "history": [], "holdings_performance": [], "stale": False}

    total_cost = Decimal("0")
    current_value = Decimal("0")
    holdings_perf = []

    # Fix N+1: resolve all instruments in one query, index by id.
    valid_holdings = [h for h in holdings if h.entry_price and h.quantity]
    inst_ids = {h.instrument_id for h in valid_holdings}
    inst_by_id = {}
    if inst_ids:
        inst_rows = await db.execute(
            select(Instrument).where(Instrument.id.in_(inst_ids))
        )
        inst_by_id = {i.id: i for i in inst_rows.scalars().all()}

    # Fetch all current prices concurrently (warm cache) — identical values to
    # per-symbol get_price; summation/division are order-independent.
    symbols = [inst_by_id[h.instrument_id].symbol for h in valid_holdings if h.instrument_id in inst_by_id]
    prices = await get_prices(symbols, db) if symbols else {}

    for h in valid_holdings:
        inst = inst_by_id.get(h.instrument_id)
        if not inst:
            continue

        qty = Decimal(str(h.quantity))
        entry_px = Decimal(str(h.entry_price))
        total_cost += qty * entry_px

        current_px = prices.get(inst.symbol.upper())
        h_value = qty * (current_px if current_px else entry_px)
        current_value += h_value

        stale = current_px is None
        h_pnl = (
            (current_px - entry_px) / entry_px * 100
            if current_px and entry_px > 0
            else Decimal("0")
        )
        holdings_perf.append({
            "symbol": inst.symbol,
            "name": inst.name,
            "asset_class": inst.asset_class,
            "quantity": str(qty),
            "current_price": str(current_px.quantize(Decimal("0.01"))) if current_px else None,
            "entry_price": str(entry_px.quantize(Decimal("0.01"))),
            "value": str(h_value.quantize(Decimal("0.01"))),
            "pnl_pct": str(h_pnl.quantize(Decimal("0.01"))),
            "stale": stale,
        })

    # Per-holding weight from current value (one pass after the total is known).
    if current_value > 0:
        for hp in holdings_perf:
            hp["weight"] = str((Decimal(hp["value"]) / current_value).quantize(Decimal("0.0001")))

    if total_cost == 0:
        return {
            "pnl_absolute": "0", "pnl_percent": "0",
            "total_value": str(current_value.quantize(Decimal("0.01"))),
            "history": await _snapshot_history(),
            "holdings_performance": holdings_perf, "stale": False,
        }

    pnl_abs = current_value - total_cost
    pnl_pct = pnl_abs / total_cost

    return {
        "pnl_absolute": str(pnl_abs.quantize(Decimal("0.01"))),
        "pnl_percent": str(pnl_pct.quantize(Decimal("0.0001"))),
        "total_value": str(current_value.quantize(Decimal("0.01"))),
        "total_cost": str(total_cost.quantize(Decimal("0.01"))),
        "history": await _snapshot_history(),
        "holdings_performance": holdings_perf,
        "stale": False,
    }


@router.get("/risk")
async def get_portfolio_risk(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Risk analytics for the active portfolio (VaR/CVaR/drawdown/rolling/beta).

    Reads the backfilled price history (DB-first); each metric carries
    as_of/source/stale. Cached 5 min per user; fail-open on Redis.
    """
    from app.services.risk import compute_portfolio_risk
    from app.core.market import get_sbp_rate

    portfolio = await _load_active_portfolio(current_user, db)  # 404 if none

    key = f"risk:{current_user.id}"
    cached = await get_cached(key)
    if cached is not None:
        return JSONResponse(content=cached)

    try:
        sbp = await get_sbp_rate()
    except Exception:
        sbp = Decimal("0.115")

    data = await compute_portfolio_risk(db, portfolio.id, sbp)
    payload = jsonable_encoder(data)
    await set_cached(key, payload, 300)
    return JSONResponse(content=payload)


@router.get("/events")
async def get_events(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Upcoming dated events for the dashboard, next 120 days, soonest first:
    SBP MPC meetings (published calendar) + maturity / next coupon of the
    user's held T-bills, PIBs and sukuk (PSX debt market). Every date is
    scraped, never estimated. {events: [{date, type, title, detail, symbol}]}"""
    from datetime import date as _date, timedelta
    from app.core.market import get_debt_market_data, get_mpc_dates
    from app.data.adapters.psx_debt_adapter import PSXDebtAdapter
    from app.models.instrument import Instrument

    today = _date.today()
    horizon = today + timedelta(days=120)
    events: list[dict] = []

    for iso in await get_mpc_dates():
        d = _date.fromisoformat(iso)
        if today <= d <= horizon:
            events.append({"date": iso, "type": "mpc", "title": "SBP policy rate decision",
                           "detail": "Monetary Policy Committee meeting", "symbol": None})

    try:
        portfolio = await _load_active_portfolio(current_user, db)
    except HTTPException:
        portfolio = None
    if portfolio is not None:
        rows = (await db.execute(
            select(Instrument).join(Holding, Holding.instrument_id == Instrument.id)
            .where(Holding.portfolio_id == portfolio.id, Instrument.asset_class.in_(["tbill", "bond"]))
        )).scalars().all()
        try:
            all_debt = await get_debt_market_data()
        except Exception:
            all_debt = []
        adapter = PSXDebtAdapter()
        for inst in rows:
            # Placeholder symbols (MTB-3M, GIS-3Y-FRR) resolve to the on-the-run
            # PSX security for that tenor; raw security codes match directly.
            rec = await adapter.get_instrument(inst.symbol)
            if rec is None:
                same = [i for i in all_debt if adapter._yield_key(i) == inst.symbol.upper()]
                rec = adapter._best_active_for_tenor(same) if same else None
            if rec is None:
                continue
            code = rec.get("security_code") or inst.symbol
            for kind, field, title in (("maturity", "maturity_date", "matures"),
                                       ("coupon", "next_coupon_date", "coupon / rental due")):
                d = adapter._parse_maturity(rec.get(field))
                if d is None or not (today <= d <= horizon):
                    continue
                if kind == "coupon" and (rec.get("coupon_rate") or 0) <= 0:
                    continue  # discount bills pay no coupon
                events.append({"date": d.isoformat(), "type": kind,
                               "title": f"{inst.symbol} {title}", "detail": code, "symbol": inst.symbol})

    events.sort(key=lambda e: e["date"])
    return {"events": events}


@router.get("/holdings/{symbol}/history")
async def get_holding_history(
    symbol: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Daily PKR value series for one of the user's holdings (qty × price over
    time; USD instruments converted at the live FX rate). Mirrors the portfolio
    performance chart so each holding has its own graph. {symbol, history:[{date,value}]}."""
    from app.models.instrument import Instrument
    from app.models.price import Price
    from sqlalchemy import asc

    portfolio = await _load_active_portfolio(current_user, db)
    sym = symbol.upper()
    inst = (await db.execute(
        select(Instrument).where(Instrument.symbol == sym)
    )).scalar_one_or_none()
    if inst is None:
        return {"symbol": sym, "history": []}

    holding = next((h for h in portfolio.holdings if h.instrument_id == inst.id), None)
    qty = Decimal(str(holding.quantity)) if holding and holding.quantity else Decimal("1")

    mult = Decimal("1")
    if (inst.currency or "").upper() == "USD":
        try:
            from app.core.market import get_usd_pkr_rate
            mult = await get_usd_pkr_rate()
        except Exception:
            mult = Decimal("1")

    rows = (await db.execute(
        select(Price.price_date, Price.price)
        .where(Price.instrument_id == inst.id)
        .order_by(asc(Price.price_date))
    )).fetchall()
    history = [
        {"date": str(r[0]), "value": str((Decimal(str(r[1])) * mult * qty).quantize(Decimal("0.01")))}
        for r in rows
    ]
    return {"symbol": sym, "history": history}
