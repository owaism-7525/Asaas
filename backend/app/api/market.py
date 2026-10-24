"""
Asaas (اثاثہ) — Market API Router

Endpoints for querying asset prices, searching the asset universe, and market ticker data.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any, Dict, List, Optional, Tuple

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db
from app.models.instrument import Instrument
from app.models.price import Price
from app.schemas.market import PriceResponse, SearchResult

logger = logging.getLogger("asaas.api.market")

router = APIRouter(prefix="/market", tags=["market"])


@router.get("/price/{symbol}", response_model=PriceResponse)
async def get_price(
    symbol: str,
    db: AsyncSession = Depends(get_db),
):
    """
    Get current price for an instrument. Resolves the symbol against an
    existing Instrument row, or — for a valid-looking PSX ticker not yet
    seeded — fetches and registers it on demand via the PSX adapter waterfall.
    """
    from app.services.instrument_resolver import resolve_instrument

    instrument = await resolve_instrument(symbol, db)

    if not instrument:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Instrument {symbol} not found.",
        )

    # Query latest price from database
    price_result = await db.execute(
        select(Price)
        .where(Price.instrument_id == instrument.id)
        .order_by(Price.price_date.desc())
    )
    latest_price = price_result.scalars().first()

    if not latest_price:
        # No price on file even after resolution — be honest, don't fabricate one.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No price available for {symbol} yet.",
        )

    return PriceResponse(
        symbol=symbol,
        price=Decimal(str(latest_price.price)),
        price_date=latest_price.price_date,
        open=Decimal(str(latest_price.open)) if latest_price.open else None,
        high=Decimal(str(latest_price.high)) if latest_price.high else None,
        low=Decimal(str(latest_price.low)) if latest_price.low else None,
        volume=latest_price.volume,
        source=latest_price.source,
        fetched_at=latest_price.fetched_at,
    )


@router.get("/quote/{symbol}")
async def get_quote(
    symbol: str,
    db: AsyncSession = Depends(get_db),
) -> Dict[str, Any]:
    """
    Current market price in PKR for any asset class — powers the buy form's
    price auto-fill. Uses the read-through cache (Redis → DB → live adapter);
    USD-quoted instruments (crypto/commodities) come back already converted.
    Returns price_pkr: null when no quote exists (e.g. debt instruments).
    """
    from app.data.cache import get_price as cache_get_price
    from app.services.instrument_resolver import resolve_instrument

    instrument = await resolve_instrument(symbol, db)
    if not instrument:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Instrument {symbol} not found.",
        )

    try:
        price_pkr = await cache_get_price(instrument.symbol, db)
    except Exception:
        logger.exception("Quote lookup failed for %s", instrument.symbol)
        price_pkr = None

    return {
        "symbol": instrument.symbol,
        "asset_class": instrument.asset_class,
        "price_pkr": str(price_pkr) if price_pkr is not None else None,
        "as_of": datetime.now(timezone.utc).isoformat(),
    }


@router.get("/search", response_model=List[SearchResult])
async def search_market(
    query: str = Query(..., min_length=1),
    db: AsyncSession = Depends(get_db),
):
    """Search for instruments by symbol or name."""
    result = await db.execute(
        select(Instrument)
        .where(
            (Instrument.symbol.ilike(f"%{query}%"))
            | (Instrument.name.ilike(f"%{query}%"))
        )
        .limit(20)
    )
    instruments = result.scalars().all()
    return instruments


@router.get("/commodity-news/{symbol}")
async def get_commodity_news(
    symbol: str,
    db: AsyncSession = Depends(get_db),
):
    """Get on-demand commodity news (mock for Phase 0)."""
    return [
        {
            "headline": f"Gold prices jump on inflation concerns relating to {symbol}",
            "source": "yfinance",
            "published_at": datetime.now(timezone.utc),
        }
    ]


# ---------------------------------------------------------------------------
# Ticker — curated snapshot set (not the full seed universe)
# ---------------------------------------------------------------------------

_TICKER_STOCKS = ["HBL.KA", "OGDC.KA", "PPL.KA", "LUCK.KA", "ENGRO.KA", "MCB.KA", "UBL.KA", "FFC.KA"]
_TICKER_COMMODITY_SYMS = ["GC=F", "SI=F", "CL=F", "CT=F"]
_TICKER_COMMODITY_NAMES = {"GC=F": "Gold", "SI=F": "Silver", "CL=F": "WTI Crude", "CT=F": "Cotton"}
_TICKER_CRYPTO_IDS: Dict[str, str] = {
    "BTC": "bitcoin", "ETH": "ethereum", "SOL": "solana",
    "XRP": "ripple", "ADA": "cardano",
}
_TICKER_CRYPTO_NAMES = {"BTC": "Bitcoin", "ETH": "Ethereum", "SOL": "Solana", "XRP": "XRP", "ADA": "Cardano"}

# Redis cache keys — fresh (crypto-paced 60 s) + stale fallback (24 h)
_CACHE_KEY_FRESH = "ticker:v1:fresh"
_CACHE_KEY_STALE = "ticker:v1:stale"
_CACHE_TTL_FRESH = 60
_CACHE_TTL_STALE = 86_400


def _price_item(
    symbol: str,
    name: str,
    price: Any,
    currency: str,
    asset_class: str,
    change: Any = None,
    change_pct: Any = None,
    price_date: Any = None,
    source: str = "yfinance",
) -> Dict[str, Any]:
    today = str(date.today())
    return {
        "symbol": symbol,
        "name": name,
        "price": str(price),
        "currency": currency,
        "asset_class": asset_class,
        "change": round(float(change), 2) if change is not None else None,
        "change_pct": round(float(change_pct), 2) if change_pct is not None else None,
        "price_date": str(price_date) if price_date else today,
        "source": source,
    }


def _chg(price: Any, prev: Any) -> Tuple[Optional[float], Optional[float]]:
    """Compute absolute change and % change from price and previous close."""
    if prev is None or float(prev) == 0:
        return None, None
    c = float(price) - float(prev)
    return c, c / float(prev) * 100


async def _fetch_ticker_items(db: AsyncSession) -> Tuple[List[Dict[str, Any]], str]:
    """Fetch all ticker data from live adapters. Errors per-symbol are swallowed."""
    from app.data.adapters.yfinance_adapter import YFinanceAdapter
    from app.core.config import get_settings

    settings = get_settings()
    yf = YFinanceAdapter(max_retries=1, retry_delay=0.5)
    now = datetime.now(timezone.utc)

    # All sections run CONCURRENTLY. Previously they were awaited one after
    # another (stocks → KSE → FX → commodities → crypto → rates → news), so a
    # cold fetch (no Redis cache) took ~40s+ and blew past the frontend's 30s
    # abort, leaving the ticker blank. Running them in parallel bounds latency to
    # the slowest single section. Item order doesn't matter — the frontend
    # re-orders by symbol.

    async def _yf_section() -> List[Dict[str, Any]]:
        """All yfinance-priced symbols (stocks + KSE-100 + USD/PKR + commodities)
        in one concurrent gather."""
        out: List[Dict[str, Any]] = []
        syms = list(_TICKER_STOCKS) + ["^KSE", "PKR=X"] + list(_TICKER_COMMODITY_SYMS)
        results = await asyncio.gather(
            *[yf.fetch_price_with_change(s) for s in syms], return_exceptions=True
        )
        for sym, res in zip(syms, results):
            if isinstance(res, Exception) or not res or res.get("price") is None:
                continue
            chg, chg_pct = _chg(res["price"], res.get("prev_close"))
            if sym == "^KSE":
                out.append(_price_item("KSE-100", "KSE 100 Index", res["price"], "PKR",
                                       "psx_index", chg, chg_pct, res.get("price_date")))
            elif sym == "PKR=X":
                out.append(_price_item("USD/PKR", "US Dollar", res["price"], "PKR", "fx",
                                       chg, chg_pct, res.get("price_date")))
            elif sym in _TICKER_COMMODITY_SYMS:
                out.append(_price_item(sym, _TICKER_COMMODITY_NAMES.get(sym, sym), res["price"],
                                       "USD", "commodity", chg, chg_pct, res.get("price_date")))
            else:
                out.append(_price_item(sym, sym.replace(".KA", ""), res["price"], "PKR",
                                       "psx_stock", chg, chg_pct, res.get("price_date")))
        return out

    async def _crypto_section() -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        coin_ids = list(_TICKER_CRYPTO_IDS.values())
        # Demo keys (CG-…) must use the public api.coingecko.com host with the
        # x-cg-demo-api-key header; pro-api.coingecko.com rejects them (error 10011).
        cg_base = "https://api.coingecko.com/api/v3"
        cg_headers = (
            {"x-cg-demo-api-key": settings.coingecko_api_key}
            if getattr(settings, "coingecko_api_key", None)
            else {}
        )
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(
                    f"{cg_base}/simple/price",
                    params={"ids": ",".join(coin_ids), "vs_currencies": "pkr", "include_24hr_change": "true"},
                    headers=cg_headers,
                )
            if resp.status_code != 200:
                raise ValueError(f"CoinGecko HTTP {resp.status_code}")
            cg_data = resp.json()
            id_to_sym = {v: k for k, v in _TICKER_CRYPTO_IDS.items()}
            for cg_id, info in cg_data.items():
                sym = id_to_sym.get(cg_id)
                if not sym or info.get("pkr") is None:
                    continue
                out.append(_price_item(
                    sym, _TICKER_CRYPTO_NAMES.get(sym, sym), info["pkr"], "PKR", "crypto",
                    None, info.get("pkr_24h_change"), now.date(), "coingecko",
                ))
        except Exception as e:
            logger.warning("CoinGecko ticker fetch failed (%s) — falling back to adapter", e)
            try:
                from app.data.adapters.coingecko_adapter import CoinGeckoAdapter
                prices = await CoinGeckoAdapter().fetch_prices(list(_TICKER_CRYPTO_IDS.keys()))
                for sym, price in prices.items():
                    out.append(_price_item(sym, _TICKER_CRYPTO_NAMES.get(sym, sym), price, "PKR", "crypto",
                                           None, None, now.date(), "coingecko"))
            except Exception:
                pass
        return out

    async def _rates_section() -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        try:
            from app.core.market import get_sbp_rate
            from app.data.adapters.sbp_adapter import SBPAdapter
            sbp_rate = await get_sbp_rate()  # cached/live, or a logged stale fallback
            out.append(_price_item("SBP", "SBP Policy Rate", f"{float(sbp_rate) * 100:.2f}", "%", "rate", source="sbp"))

            # SBP auction cut-offs (T-bills, fixed PIBs) merged with PSX debt
            # market rates for the other tenors. Missing tenors are omitted.
            tbill_rates = await SBPAdapter().fetch_tbill_rates()

            for sym, label in [("MTB-3M", "3M T-Bill"), ("MTB-6M", "6M T-Bill"), ("MTB-12M", "12M T-Bill")]:
                if sym in tbill_rates:
                    out.append(_price_item(sym, label, f"{float(tbill_rates[sym]) * 100:.2f}", "%", "tbill", source="sbp"))
            for sym, label in [("PIB-3Y", "3Y PIB"), ("PIB-5Y", "5Y PIB"), ("PIB-10Y", "10Y PIB")]:
                if sym in tbill_rates:
                    out.append(_price_item(sym, label, f"{float(tbill_rates[sym]) * 100:.2f}", "%", "tbill", source="sbp"))
            if "GIS-3Y-FRR" in tbill_rates:
                out.append(_price_item("GIS-3Y", "3Y Sukuk", f"{float(tbill_rates['GIS-3Y-FRR']) * 100:.2f}",
                                       "%", "tbill", source="psx_debt"))
        except Exception:
            logger.warning("SBP/PSX debt ticker fetch failed — returning empty rates section")
        return out

    async def _news_section() -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        try:
            from app.models.news import NewsItem
            news_result = await db.execute(
                select(NewsItem).order_by(NewsItem.published_at.desc()).limit(5)
            )
            for news in news_result.scalars().all():
                out.append({
                    "symbol": "NEWS",
                    "name": news.headline[:100],
                    "price": "",
                    "currency": "",
                    "asset_class": "news",
                    "change": None,
                    "change_pct": None,
                    "price_date": str(news.published_at.date()) if news.published_at else str(now.date()),
                    "source": news.source,
                })
        except Exception:
            pass
        return out

    sections = await asyncio.gather(
        _yf_section(), _crypto_section(), _rates_section(), _news_section(),
        return_exceptions=True,
    )
    items: List[Dict[str, Any]] = []
    for sec in sections:
        if isinstance(sec, list):
            items.extend(sec)

    return items, now.isoformat()


@router.get("/ticker")
async def get_ticker(db: AsyncSession = Depends(get_db)) -> Dict[str, Any]:
    """
    Live market ticker snapshot. No auth required.
    Cached in Redis: 60 s fresh (crypto cadence), 24 h stale fallback.
    Returns {items, as_of, stale}.
    """
    from app.core.redis import redis_client

    # Fresh cache hit (fail-open: a Redis outage must not 500 the ticker — it
    # just means we build live, like every other market endpoint).
    try:
        raw = await redis_client.get(_CACHE_KEY_FRESH)
        if raw:
            return json.loads(raw)
    except Exception:
        pass

    # Build from adapters
    items, as_of = await _fetch_ticker_items(db)

    if items:
        payload = {"items": items, "as_of": as_of, "stale": False}
        serialized = json.dumps(payload, default=str)
        try:
            await asyncio.gather(
                redis_client.setex(_CACHE_KEY_FRESH, _CACHE_TTL_FRESH, serialized),
                redis_client.setex(_CACHE_KEY_STALE, _CACHE_TTL_STALE, serialized),
            )
        except Exception:
            pass
        return payload

    # Stale fallback — return last known snapshot with stale flag
    try:
        stale_raw = await redis_client.get(_CACHE_KEY_STALE)
        if stale_raw:
            stale_payload = json.loads(stale_raw)
            stale_payload["stale"] = True
            return stale_payload
    except Exception:
        pass

    return {"items": [], "as_of": None, "stale": True}


# ---------------------------------------------------------------------------
# Debt Market — PSX government and corporate debt securities
# ---------------------------------------------------------------------------

_DEBT_CACHE_KEY_API = "ticker:v1:debt_market"
_DEBT_CACHE_TTL_API = 3600


@router.get("/debt/{symbol}")
async def get_debt_instrument(symbol: str) -> Dict[str, Any]:
    """
    Live record for a single PSX debt instrument (by security_code or friendly
    tenor key such as MTB-3M / PIB-5Y). Powers the holding detail page's live
    debt fields without a full valuation call. 24h-cached in the adapter.
    """
    from app.data.adapters.psx_debt_adapter import PSXDebtAdapter

    inst = await PSXDebtAdapter().get_instrument(symbol)
    if not inst:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No PSX debt instrument found for '{symbol}'.",
        )
    return inst


@router.get("/debt-market")
async def get_debt_market() -> Dict[str, Any]:
    """
    PSX debt market snapshot — government and corporate debt securities.
    Scrapes live from PSX, caches in Redis if available.
    Returns {items, as_of, stale, count}.
    """
    now = datetime.now(timezone.utc)

    # 1. Try Redis cache first (non-blocking)
    try:
        from app.core.redis import redis_client
        raw = await asyncio.wait_for(redis_client.get(_DEBT_CACHE_KEY_API), timeout=2.0)
        if raw:
            return json.loads(raw)
    except Exception:
        pass

    # 2. Scrape directly from PSX (no Redis dependency)
    try:
        from app.data.adapters.psx_debt_adapter import PSXDebtAdapter
        instruments = await PSXDebtAdapter().fetch_all_instruments()
        if instruments:
            payload = {
                "items": instruments,
                "as_of": now.isoformat(),
                "stale": False,
                "count": len(instruments),
            }
            # Try to cache (non-blocking)
            try:
                import asyncio
                from app.core.redis import redis_client
                serialized = json.dumps(payload, default=str)
                await asyncio.wait_for(
                    redis_client.setex(_DEBT_CACHE_KEY_API, _DEBT_CACHE_TTL_API, serialized),
                    timeout=2.0,
                )
            except Exception:
                pass
            return payload
    except Exception as e:
        logger.warning("PSX debt scrape failed: %s", e)

    # 3. Try stale cache (non-blocking)
    try:
        from app.core.redis import redis_client
        stale_raw = await asyncio.wait_for(redis_client.get(_DEBT_CACHE_KEY_API), timeout=2.0)
        if stale_raw:
            stale_payload = json.loads(stale_raw)
            stale_payload["stale"] = True
            return stale_payload
    except Exception:
        pass

    # 4. Return empty — no crash
    return {"items": [], "as_of": now.isoformat(), "stale": True, "count": 0}
