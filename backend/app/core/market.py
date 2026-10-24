"""
Asaas (اثاثہ) — Shared Market Utilities

Live FX rate and SBP rate helpers with Redis caching.
Used by performance, valuation, optimizer, daily_eod — anywhere a
FX conversion or risk-free rate is needed.
"""

from __future__ import annotations

import logging
import time
from decimal import Decimal, InvalidOperation

from app.core.redis import redis_client

logger = logging.getLogger("asaas.market_utils")

_FX_CACHE_KEY = "market:fx:usd_pkr"
_FX_CACHE_TTL = 3600  # 1 hour — FX is stable intraday
# Persistent last-known-good FX rate (no expiry) — the most recent real rate,
# used as a graceful fallback so a transient outage never blocks valuation.
_FX_LAST_GOOD_KEY = "market:fx:usd_pkr:last_good"
# Last resort when every FX tier fails (fresh Redis + Yahoo and DuckDuckGo down).
# Never written to Redis, so it can't masquerade as a live rate.
# 276.51 = live Yahoo USD/PKR close on 2026-10-23 — refresh if PKR moves a lot.
FX_RATE_FALLBACK = Decimal("276.51")
# Where the most recent get_usd_pkr_rate() value came from:
# "cache" | "live" | "last_good" | "fallback". "fallback" means stale/not live.
last_fx_rate_source: str = "fallback"
# After every live source fails, skip them for this long so a Yahoo outage
# doesn't add retries to every request on a cold Redis.
_FX_RETRY_AFTER = 300
_fx_retry_at = 0.0

_SBP_CACHE_KEY = "market:sbp:policy_rate"
_SBP_CACHE_TTL = 3600  # 1 hour
# Persistent last-known-good rate — NO expiry. Written on every successful live
# fetch and used as the graceful fallback when the 1h cache has expired and the
# live scrape is down. This is "the most recent REAL rate" (ages slowly), not a
# frozen hardcoded guess. See get_sbp_rate.
_SBP_LAST_GOOD_KEY = "market:sbp:policy_rate:last_good"
# Last resort when cache, live scrape and last-known-good all fail (fresh Redis
# + SBP down). Never written to Redis, so it can't masquerade as a live rate.
# 11.50% = SBP policy rate as scraped live on 2026-10-24 — update on MPC changes.
SBP_RATE_FALLBACK = Decimal("0.115")
# Where the most recent get_sbp_rate() value came from:
# "cache" | "live" | "last_good" | "fallback". "fallback" means stale/not live.
last_sbp_rate_source: str = "fallback"
# After a failed live scrape, skip re-scraping for this long so a down SBP site
# doesn't add a 15s scrape to every request on a cold Redis.
_SBP_RETRY_AFTER = 300
_sbp_retry_at = 0.0

_DEBT_CACHE_KEY = "market:psx:debt_instruments"
_DEBT_CACHE_TTL = 3600  # 1 hour


async def get_usd_pkr_rate() -> Decimal:
    """
    Fetch live USD/PKR from yfinance, cached in Redis for 1 hour. Never raises.

    Fallback chain: 1h cache → yfinance → DuckDuckGo → **last-known-good** →
    ``FX_RATE_FALLBACK`` (logged as STALE, ``last_fx_rate_source == "fallback"``).
    """
    global last_fx_rate_source, _fx_retry_at

    # 1. Try Redis cache
    try:
        cached = await redis_client.get(_FX_CACHE_KEY)
        if cached:
            last_fx_rate_source = "cache"
            return Decimal(cached)
    except Exception:
        pass

    if time.monotonic() >= _fx_retry_at:
        # 2. Fetch from yfinance
        try:
            from app.data.adapters.yfinance_adapter import YFinanceAdapter
            yf = YFinanceAdapter(max_retries=2, retry_delay=1.0)
            result = await yf.fetch_price("PKR=X")
            if result and result.get("price") is not None:
                rate = Decimal(str(result["price"]))
                await _cache_fx(rate)
                logger.info("Fetched live USD/PKR rate: %s", rate)
                last_fx_rate_source = "live"
                return rate
        except Exception as e:
            logger.warning("yfinance USD/PKR fetch failed: %s", e)

        # 3. DuckDuckGo search fallback (no API key) before giving up on a live rate.
        try:
            from app.data.adapters.fx_search_adapter import fetch_usd_pkr_via_search
            rate = await fetch_usd_pkr_via_search()
            if rate is not None:
                await _cache_fx(rate)
                last_fx_rate_source = "live"
                return rate
        except Exception as e:
            logger.warning("DuckDuckGo USD/PKR fallback failed: %s", e)

        _fx_retry_at = time.monotonic() + _FX_RETRY_AFTER

    # 4. Persistent last-known-good (most recent real rate, ages gracefully)
    try:
        last_good = await redis_client.get(_FX_LAST_GOOD_KEY)
        if last_good:
            logger.warning("Using last-known-good USD/PKR rate: %s", last_good)
            last_fx_rate_source = "last_good"
            return Decimal(last_good)
    except Exception:
        pass

    # 5. Hardcoded last resort — stale, flagged, never cached.
    logger.error(
        "USD/PKR STALE FALLBACK in use (%s) — no cache, live source or "
        "last-known-good available", FX_RATE_FALLBACK,
    )
    last_fx_rate_source = "fallback"
    return FX_RATE_FALLBACK


async def _cache_fx(rate: Decimal) -> None:
    """Write the 1h cache + the persistent last-known-good rate."""
    try:
        await redis_client.setex(_FX_CACHE_KEY, _FX_CACHE_TTL, str(rate))
        await redis_client.set(_FX_LAST_GOOD_KEY, str(rate))
    except Exception:
        pass


async def get_sbp_rate() -> Decimal:
    """
    Fetch the live SBP policy rate, cached in Redis for 1 hour. Never raises.

    Fallback chain: fresh 1h cache → live scrape → **last-known-good** (the most
    recent successful live fetch, persisted with no expiry) → ``SBP_RATE_FALLBACK``
    (logged as STALE, ``last_sbp_rate_source == "fallback"``). The app degrades
    to a stale rate instead of 500-ing.
    """
    global last_sbp_rate_source, _sbp_retry_at

    # 1. Try the fresh 1h cache
    try:
        cached = await redis_client.get(_SBP_CACHE_KEY)
        if cached:
            last_sbp_rate_source = "cache"
            return Decimal(cached)
    except Exception:
        pass

    # 2. Fetch live from the SBP adapter (returns None on total scrape failure).
    #    Skipped for _SBP_RETRY_AFTER seconds after a failure.
    if time.monotonic() >= _sbp_retry_at:
        try:
            from app.data.adapters.sbp_adapter import SBPAdapter
            rate = await SBPAdapter().fetch_policy_rate()
            if rate is not None:
                # Write BOTH the 1h cache and the persistent last-known-good key.
                try:
                    await redis_client.setex(_SBP_CACHE_KEY, _SBP_CACHE_TTL, str(rate))
                    await redis_client.set(_SBP_LAST_GOOD_KEY, str(rate))
                except Exception:
                    pass
                logger.info("Fetched live SBP policy rate: %s%%", rate * 100)
                last_sbp_rate_source = "live"
                return rate
        except Exception as e:
            logger.warning("SBP policy rate live fetch failed: %s", e)
        _sbp_retry_at = time.monotonic() + _SBP_RETRY_AFTER

    # 3. Fall back to the last-known-good value (most recent real fetch)
    try:
        last_good = await redis_client.get(_SBP_LAST_GOOD_KEY)
        if last_good:
            logger.warning("Using last-known-good SBP rate (live fetch unavailable): %s", last_good)
            last_sbp_rate_source = "last_good"
            return Decimal(last_good)
    except Exception:
        pass

    # 4. Hardcoded last resort — stale, flagged, never cached.
    logger.error(
        "SBP policy rate STALE FALLBACK in use (%s) — no cache, live scrape or "
        "last-known-good available", SBP_RATE_FALLBACK,
    )
    last_sbp_rate_source = "fallback"
    return SBP_RATE_FALLBACK


async def get_debt_market_data() -> list:
    """
    Fetch PSX debt market instruments, cached in Redis for 1 hour.
    Falls back to stale cache, then raises on total failure.
    """
    # 1. Try Redis cache
    try:
        cached = await redis_client.get(_DEBT_CACHE_KEY)
        if cached:
            import json
            return json.loads(cached)
    except Exception:
        pass

    # 2. Fetch from PSX debt adapter
    try:
        from app.data.adapters.psx_debt_adapter import PSXDebtAdapter
        instruments = await PSXDebtAdapter().fetch_all_instruments()
        if instruments:
            try:
                import json
                await redis_client.setex(
                    _DEBT_CACHE_KEY, _DEBT_CACHE_TTL,
                    json.dumps(instruments, default=str)
                )
            except Exception:
                pass
            logger.info("Fetched %d PSX debt instruments", len(instruments))
            return instruments
    except Exception as e:
        logger.warning("PSX debt market fetch failed: %s", e)

    # 3. Try stale cache
    try:
        cached = await redis_client.get(_DEBT_CACHE_KEY)
        if cached:
            import json
            logger.warning("Using stale PSX debt market cache")
            return json.loads(cached)
    except Exception:
        pass

    raise RuntimeError("Cannot fetch PSX debt market data — no live or cached data available")


_MPC_CACHE_KEY = "market:sbp:mpc_dates"
_MPC_CACHE_TTL = 86400  # 24h — SBP publishes the schedule a year ahead


async def get_mpc_dates() -> list:
    """SBP MPC meeting dates (ISO strings), cached 24h. [] when unavailable."""
    import json
    try:
        cached = await redis_client.get(_MPC_CACHE_KEY)
        if cached:
            return json.loads(cached)
    except Exception:
        pass
    from app.data.adapters.sbp_adapter import SBPAdapter
    dates = [d.isoformat() for d in await SBPAdapter().fetch_mpc_dates()]
    if dates:
        try:
            await redis_client.setex(_MPC_CACHE_KEY, _MPC_CACHE_TTL, json.dumps(dates))
        except Exception:
            pass
    return dates
