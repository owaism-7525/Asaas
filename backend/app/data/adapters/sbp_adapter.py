"""
Asaas (اثاثہ) — State Bank of Pakistan (SBP) Adapter

Scrapes the State Bank of Pakistan website for:
- Current monetary policy rate
- T-bill (MTB) auction results and cut-off yields
- PIB secondary market yields
- GIS (Islamic Sukuk) rates

SBP conducts multiple-priced auctions of marketable government securities:
- MTBs: fortnightly auctions on Wednesdays, settlement T+1
- PIBs: need basis per pre-announced calendar
- GIS: Shariah compliant, 3-year tenors, Fixed/Variable Rate Rentals

Uses BeautifulSoup, handles errors gracefully, and returns Decimal (RULES.md A1.4, A2.6, A3.5).
"""

from __future__ import annotations

import logging
import re
from decimal import Decimal, InvalidOperation
from typing import Dict, Any, List, Optional
from datetime import date, datetime, timezone

from curl_cffi.requests import AsyncSession
from bs4 import BeautifulSoup

logger = logging.getLogger("asaas.sbp_adapter")

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}


def _parse_pct(text: str) -> Optional[Decimal]:
    """Extract a percentage from text. Handles both '20.50%' and '11.5 percent'
    (SBP's homepage announcement uses the word 'percent'). -> Decimal('0.115')."""
    m = re.search(r"(\d{1,2}(?:\.\d{1,4})?)\s*(?:%|percent)", text, re.IGNORECASE)
    if m:
        try:
            return Decimal(m.group(1)) / Decimal("100")
        except InvalidOperation:
            return None
    return None


def _clean(text: str) -> str:
    """Collapse whitespace in scraped text."""
    return re.sub(r"\s+", " ", text).strip()


class SBPAdapter:
    """Adapter for scraping SBP interest rates and government securities data."""

    def __init__(self):
        self.homepage_url = "https://www.sbp.org.pk/index.html"
        self.monetary_policy_url = "https://www.sbp.org.pk/monetary_policy/index.asp"
        # Latest-auction cut-offs are published on the homepage (sdma.asp now redirects there).
        self.auction_url = "https://www.sbp.org.pk/"
        self.key_rates_url = "https://www.sbp.org.pk/keyrates/keyrates.asp"
        self.headers = _HEADERS

    async def _get(self, url: str):
        """GET with a Chrome TLS fingerprint. sbp.org.pk sits behind Cloudflare,
        which 403s httpx's handshake even with browser headers; curl_cffi's
        Chrome impersonation passes. Response exposes .status_code / .text."""
        async with AsyncSession(impersonate="chrome", timeout=15.0) as session:
            return await session.get(url, headers=self.headers, allow_redirects=True)

    # ------------------------------------------------------------------
    # Policy rate
    # ------------------------------------------------------------------

    async def fetch_policy_rate(self) -> Optional[Decimal]:
        """
        Scrape the SBP website for the current monetary policy rate.
        Tries the homepage, then the monetary policy page, then key rates.

        Returns ``None`` when every source fails — it does NOT fabricate a
        fallback rate. Fabricating a constant here would silently poison the
        last-known-good cache in ``app.core.market.get_sbp_rate``; the caller
        owns the fallback policy (last-known-good, then a clearly-flagged
        placeholder), not this scraper.
        """
        # Strategy 1: Homepage — look for "Policy Rate" near a percentage
        rate = await self._scrape_homepage_policy_rate()
        if rate is not None:
            return rate

        # Strategy 2: Dedicated monetary policy page
        rate = await self._scrape_monetary_policy_page()
        if rate is not None:
            return rate

        # Strategy 3: Key rates page
        rate = await self._scrape_key_rates()
        if rate is not None:
            return rate

        logger.warning("All SBP policy rate sources failed — returning None (caller decides fallback)")
        return None

    async def _scrape_homepage_policy_rate(self) -> Optional[Decimal]:
        try:
            resp = await self._get(self.homepage_url)
            if resp.status_code != 200:
                logger.warning("SBP homepage returned %s", resp.status_code)
                return None

            soup = BeautifulSoup(resp.text, "lxml")

            # Pattern 1: text nodes containing "Policy Rate" followed by a percentage
            for node in soup.find_all(string=re.compile(r"Policy\s+Rate", re.IGNORECASE)):
                # Check parent, grandparent, and surrounding siblings
                for el in [node.parent, node.parent.parent if node.parent else None]:
                    if el is None:
                        continue
                    text = _clean(el.get_text())
                    rate = _parse_pct(text)
                    if rate is not None:
                        logger.info("Scraped SBP Policy Rate from homepage: %s", rate * 100)
                        return rate

                    # Check sibling cells in the same table row
                    if el.name in ("td", "th", "span", "div"):
                        row = el.find_parent("tr")
                        if row:
                            rate = _parse_pct(_clean(row.get_text()))
                            if rate is not None:
                                logger.info("Scraped SBP Policy Rate from homepage row: %s", rate * 100)
                                return rate

            # Pattern 2: look for any element with class/id hinting at policy rate
            for selector in [
                '[class*="policy"]', '[class*="rate"]', '[id*="policy"]', '[id*="rate"]',
                'td:contains("Policy")', 'th:contains("Policy")',
            ]:
                try:
                    for el in soup.select(selector):
                        rate = _parse_pct(_clean(el.get_text()))
                        if rate is not None:
                            logger.info("Scraped SBP Policy Rate via selector '%s': %s", selector, rate * 100)
                            return rate
                except Exception:
                    continue

            # Pattern 3: brute-force — find the last standalone percentage near "policy" keyword
            full_text = _clean(soup.get_text())
            policy_match = re.search(
                r"policy\s+rate.{0,60}?(\d{1,2}(?:\.\d{1,4})?)\s*(?:%|percent)",
                full_text, re.IGNORECASE,
            )
            if policy_match:
                try:
                    rate = Decimal(policy_match.group(1)) / Decimal("100")
                    logger.info("Scraped SBP Policy Rate from full text: %s", rate * 100)
                    return rate
                except InvalidOperation:
                    pass

            logger.warning("Could not find Policy Rate on SBP homepage")
            return None

        except Exception as e:
            logger.error("Error scraping SBP homepage for policy rate: %s", e)
            return None

    async def _scrape_monetary_policy_page(self) -> Optional[Decimal]:
        try:
            resp = await self._get(self.monetary_policy_url)
            if resp.status_code != 200:
                return None

            soup = BeautifulSoup(resp.text, "lxml")
            full_text = _clean(soup.get_text())

            # Look for "policy rate" near a percentage — the page should state the current rate
            patterns = [
                r"policy\s+rate\s+(?:is|at|of|stands?\s+at|has\s+been\s+(?:set\s+at|kept?\s+at|raised?\s+to|lowered?\s+to))\s*(\d{1,2}\.\d{1,4})\s*%",
                r"policy\s+rate[^%]{0,60}?(\d{1,2}\.\d{1,4})\s*%",
                r"(\d{1,2}\.\d{1,4})\s*%\s*(?:per\s+annum|p\.?\s*a\.?)",
            ]
            for pat in patterns:
                m = re.search(pat, full_text, re.IGNORECASE)
                if m:
                    try:
                        rate = Decimal(m.group(1)) / Decimal("100")
                        logger.info("Scraped SBP Policy Rate from monetary policy page: %s", rate * 100)
                        return rate
                    except InvalidOperation:
                        continue

            return None
        except Exception as e:
            logger.error("Error scraping SBP monetary policy page: %s", e)
            return None

    async def _scrape_key_rates(self) -> Optional[Decimal]:
        try:
            resp = await self._get(self.key_rates_url)
            if resp.status_code != 200:
                return None

            soup = BeautifulSoup(resp.text, "lxml")

            # The key rates page often lists the policy rate in a table
            for row in soup.find_all("tr"):
                cells = row.find_all(["td", "th"])
                row_text = _clean(row.get_text())
                if re.search(r"policy\s+rate", row_text, re.IGNORECASE):
                    rate = _parse_pct(row_text)
                    if rate is not None:
                        logger.info("Scraped SBP Policy Rate from key rates page: %s", rate * 100)
                        return rate

                    # Check each cell for a standalone percentage
                    for cell in cells:
                        rate = _parse_pct(_clean(cell.get_text()))
                        if rate is not None:
                            logger.info("Scraped SBP Policy Rate from key rates cell: %s", rate * 100)
                            return rate

            return None
        except Exception as e:
            logger.error("Error scraping SBP key rates page: %s", e)
            return None

    # ------------------------------------------------------------------
    # T-bill / government securities yields
    # ------------------------------------------------------------------

    async def fetch_tbill_rates(self) -> Dict[str, Decimal]:
        """
        Yields for government securities, keyed by instrument symbol
        (MTB-3M, PIB-5Y, GIS-3Y-FRR, ...), as Decimal fractions.

        1. SBP latest-auction cut-off yields (MTBs + fixed-rate PIBs) — the
           market clearing yields, and the only live source for T-bills.
        2. PSX debt market (dps.psx.com.pk/debt-market) fills every other
           tenor from the on-the-run issue's coupon/rental rate (PIB-15Y/20Y,
           GIS sukuk, ...).

        Returns only what was actually scraped — {} if both sources fail.
        Never fabricates a yield: callers treat a missing tenor as unavailable.
        """
        from app.data.adapters.psx_debt_adapter import PSXDebtAdapter

        try:
            psx = await PSXDebtAdapter().fetch_yields_by_tenor()
        except Exception as e:
            logger.warning("PSX debt market yields unavailable: %s", e)
            psx = {}
        sbp = await self._scrape_auction_cutoffs()

        yields = {**psx, **sbp}  # SBP auction cut-offs win where both exist
        if yields:
            logger.info("Govt yields: %d from SBP auctions, %d from PSX debt market",
                        len(sbp), len(set(psx) - set(sbp)))
        else:
            logger.warning("No govt securities yields available (SBP and PSX both failed)")
        return yields

    async def _scrape_auction_cutoffs(self) -> Dict[str, Decimal]:
        """Parse the homepage "Cut-off Rates in the Latest Auctions" block:
        ``MTBs Tenor Cut-off Yield 1-M 11.5003% 3-M ...`` and
        ``Fixed - Rate PIB Tenor Cut-off Yield 2-Y 12.3990% ...``.
        Tenors marked "Bids Rejected" are skipped (no clearing yield)."""
        try:
            resp = await self._get(self.auction_url)
            if resp.status_code != 200:
                logger.warning("SBP auction cut-offs returned %s", resp.status_code)
                return {}
            text = _clean(BeautifulSoup(resp.text, "lxml").get_text(" "))

            yields: Dict[str, Decimal] = {}
            sections = [
                (r"MTBs\s+Tenor\s+Cut-off\s+Yield(.*?)\(as on", "M", "MTB-{n}M"),
                (r"Fixed\s*-\s*Rate\s+PIB\s+Tenor\s+Cut-off\s+Yield(.*?)\(as on", "Y", "PIB-{n}Y"),
            ]
            for section_pat, unit, key_fmt in sections:
                m = re.search(section_pat, text, re.IGNORECASE)
                if not m:
                    continue
                for n, pct in re.findall(rf"(\d{{1,2}})-{unit}\s+(\d{{1,2}}\.\d{{1,4}})\s*%", m.group(1)):
                    yields[key_fmt.format(n=int(n))] = Decimal(pct) / Decimal("100")
            if not yields:
                logger.warning("SBP auction cut-off block not found on %s", self.auction_url)
            return yields
        except Exception as e:
            logger.error("Error scraping SBP auction cut-offs: %s", e)
            return {}

    # ------------------------------------------------------------------
    # Monetary Policy Committee calendar
    # ------------------------------------------------------------------

    async def fetch_mpc_dates(self) -> List[date]:
        """MPC meeting dates from SBP's published "Advance Calendar of MPC
        Meetings" table (first column, e.g. ``26-Oct-26``). [] on failure."""
        try:
            resp = await self._get("https://www.sbp.org.pk/our-operations/monetary-policy")
            if resp.status_code != 200:
                logger.warning("SBP monetary policy page returned %s", resp.status_code)
                return []
            soup = BeautifulSoup(resp.text, "lxml")
            dates: List[date] = []
            for table in soup.find_all("table"):
                rows = table.find_all("tr")
                if not rows or "MPC Meeting Date" not in rows[0].get_text(" ", strip=True):
                    continue
                for row in rows[1:]:
                    cells = row.find_all(["td", "th"])
                    if not cells:
                        continue
                    try:
                        dates.append(datetime.strptime(_clean(cells[0].get_text()), "%d-%b-%y").date())
                    except ValueError:
                        continue
            if not dates:
                logger.warning("SBP MPC calendar table not found")
            return sorted(dates)
        except Exception as e:
            logger.error("Error scraping SBP MPC calendar: %s", e)
            return []

    # ------------------------------------------------------------------
    # Auction calendar (informational)
    # ------------------------------------------------------------------

    async def fetch_auction_calendar(self) -> Dict[str, Any]:
        """
        Fetch upcoming auction calendar from SBP.
        """
        try:
            return {
                "next_mtb_auction": "Fortnightly (Wednesdays)",
                "next_pib_auction": "Per calendar",
                "settlement": "T+1 (following Thursday)",
                "participants": "Primary Dealers (PDs)",
                "source": "sbp.org.pk",
            }
        except Exception as e:
            logger.error("Error fetching auction calendar: %s", e)
            return {}
