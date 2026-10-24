"""
Asaas (اثاثہ) — PSX Debt Market Adapter

Scrapes the Pakistan Stock Exchange (PSX) Debt Market page for
government and corporate debt securities data:
- GoP Ijarah Sukuk (Islamic lease-based)
- Public Debt Securities (corporate Sukuk/TFCs)
- Privately Placed Debt Securities
- Government Debt Securities (PIBs, T-Bills)

Source: https://dps.psx.com.pk/debt-market (fully server-rendered HTML)
Returns Decimal for yields/rates (RULES.md A1.4, A2.6, A3.5).
"""

from __future__ import annotations

import logging
import re
from decimal import Decimal, InvalidOperation
from typing import Dict, List, Any, Optional
from datetime import date, datetime

import httpx
from bs4 import BeautifulSoup

logger = logging.getLogger("asaas.psx_debt_adapter")

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

_DEBT_MARKET_URL = "https://dps.psx.com.pk/debt-market"


def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def _parse_decimal(text: str) -> Optional[Decimal]:
    text = text.replace(",", "").strip()
    m = re.search(r"(\d+\.?\d*)", text)
    if m:
        try:
            return Decimal(m.group(1))
        except InvalidOperation:
            return None
    return None


def _parse_pct(text: str) -> Optional[Decimal]:
    m = re.search(r"(\d{1,2}\.\d{1,4})\s*%", text)
    if m:
        try:
            return Decimal(m.group(1)) / Decimal("100")
        except InvalidOperation:
            return None
    return None


def _parse_issue_size(text: str) -> Optional[Decimal]:
    text = text.strip().replace(",", "")
    m = re.match(r"([\d.]+)\s*(T|B|M|K)?", text, re.IGNORECASE)
    if not m:
        return None
    try:
        val = Decimal(m.group(1))
        suffix = (m.group(2) or "").upper()
        multipliers = {"T": Decimal("1e12"), "B": Decimal("1e9"), "M": Decimal("1e6"), "K": Decimal("1e3")}
        return val * multipliers.get(suffix, Decimal("1"))
    except InvalidOperation:
        return None


class PSXDebtAdapter:
    """Adapter for scraping PSX debt market data."""

    def __init__(self):
        self.url = _DEBT_MARKET_URL
        self.headers = _HEADERS

    async def fetch_all_instruments(self) -> List[Dict[str, Any]]:
        """
        Fetch all debt instruments from the PSX debt market page.
        Returns a list of dicts with keys:
            security_code, security_name, face_value, listing_date,
            issue_date, issue_size, maturity_date, coupon_rate,
            prev_coupon_date, next_coupon_date, outstanding_days,
            remaining_years, category
        """
        try:
            async with httpx.AsyncClient(timeout=20.0, follow_redirects=True) as client:
                resp = await client.get(self.url, headers=self.headers)
            if resp.status_code != 200:
                logger.warning("PSX debt market returned %s", resp.status_code)
                return []

            soup = BeautifulSoup(resp.text, "lxml")
            instruments: List[Dict[str, Any]] = []

            tables = soup.find_all("table", class_="tbl")
            if not tables:
                tables = soup.find_all("table")

            category_map = {
                0: "gop_sukuk",
                1: "public_debt",
                2: "private_debt",
                3: "govt_debt",
            }

            for idx, table in enumerate(tables):
                category = category_map.get(idx, f"unknown_{idx}")
                rows = table.find_all("tr")
                if not rows:
                    continue
                # Columns are located by header text, not position: the
                # Government Debt table omits Face Value / Listing Date.
                # "Coupon/ Rental" vs "Coupon/Rental" spacing is normalised.
                header = [_clean(c.get_text()).lower().replace("/ ", "/") for c in rows[0].find_all(["td", "th"])]
                col = {name: i for i, name in enumerate(header)}
                if "security code" not in col:
                    continue

                def cell(texts: List[str], *names: str) -> str:
                    for n in names:
                        i = col.get(n)
                        if i is not None and i < len(texts):
                            return texts[i]
                    return ""

                for row in rows[1:]:
                    cell_texts = [_clean(c.get_text()) for c in row.find_all(["td", "th"])]
                    if len(cell_texts) < len(header) or not cell_texts[0]:
                        continue

                    coupon = _parse_pct(cell(cell_texts, "coupon/rental rate"))
                    remaining = _parse_decimal(cell(cell_texts, "remaining years"))
                    face = _parse_decimal(cell(cell_texts, "face value"))
                    size = _parse_issue_size(cell(cell_texts, "issue size"))
                    days = _parse_decimal(cell(cell_texts, "outstanding days"))
                    inst = {
                        "security_code": cell(cell_texts, "security code"),
                        "security_name": cell(cell_texts, "security name"),
                        "face_value": float(face) if face is not None else None,
                        "listing_date": cell(cell_texts, "listing date"),
                        "issue_date": cell(cell_texts, "issue date"),
                        "issue_size": float(size) if size is not None else None,
                        "maturity_date": cell(cell_texts, "maturity date"),
                        "coupon_rate": float(coupon) if coupon is not None else None,
                        "prev_coupon_date": cell(cell_texts, "previous coupon/rental date"),
                        "next_coupon_date": cell(cell_texts, "next coupon/rental date"),
                        "outstanding_days": float(days) if days is not None else None,
                        "remaining_years": float(remaining) if remaining is not None else None,
                        "category": category,
                    }
                    instruments.append(inst)

            logger.info("Scraped %d debt instruments from PSX", len(instruments))
            return instruments

        except Exception as e:
            logger.error("Error scraping PSX debt market: %s", e)
            return []

    @staticmethod
    def _tenor_key(inst: Dict[str, Any]) -> Optional[str]:
        """Map a govt-debt instrument to a friendly tenor key (MTB-3M, PIB-5Y, …).

        Mirrors the mapping used by ``fetch_yields_by_tenor`` so a user-facing
        symbol like ``MTB-3M`` can be resolved back to a scraped instrument.
        Uses word boundaries (so "15 year" is not read as "5 year") and checks
        Sukuk/GIS before the PIB code prefixes (so ``P05GIS…`` isn't read as a PIB).
        """
        if inst.get("category") != "govt_debt":
            return None
        code = (inst.get("security_code") or "").upper()
        name = (inst.get("security_name") or "").lower()

        # Sukuk / GIS first — their codes (e.g. P05GIS…) would otherwise match a
        # PIB code prefix below.
        if "gis" in code.lower() or "sukuk" in name or "gis" in name:
            return "GIS-3Y"

        # T-bill code prefixes (most reliable).
        tbill_prefix = {"PK01TB": "MTB-1M", "PK03TB": "MTB-3M", "PK06TB": "MTB-6M", "PK12TB": "MTB-12M"}
        for pfx, key in tbill_prefix.items():
            if code.startswith(pfx):
                return key

        # PIB code prefixes Pnn (P02..P20).
        pib_prefix = {"P02": "PIB-2Y", "P03": "PIB-3Y", "P05": "PIB-5Y",
                      "P07": "PIB-7Y", "P10": "PIB-10Y", "P20": "PIB-20Y"}
        for pfx, key in pib_prefix.items():
            if code.startswith(pfx):
                return key

        # Name fallback with word boundaries (avoids "15 year" → "5 year").
        name_patterns = [
            (r"\b1[\s-]?month\b", "MTB-1M"), (r"\b3[\s-]?month\b", "MTB-3M"),
            (r"\b6[\s-]?month\b", "MTB-6M"), (r"\b12[\s-]?month\b", "MTB-12M"),
            (r"\b2[\s-]?year\b", "PIB-2Y"), (r"\b3[\s-]?year\b", "PIB-3Y"),
            (r"\b5[\s-]?year\b", "PIB-5Y"), (r"\b7[\s-]?year\b", "PIB-7Y"),
            (r"\b10[\s-]?year\b", "PIB-10Y"), (r"\b20[\s-]?year\b", "PIB-20Y"),
        ]
        for pat, key in name_patterns:
            if re.search(pat, name):
                return key
        return None

    @staticmethod
    def _parse_maturity(value: Any) -> Optional[date]:
        """Parse PSX maturity strings like 'January 08, 2026' into a date."""
        if not value:
            return None
        try:
            from dateutil import parser as _dateparser
            return _dateparser.parse(str(value)).date()
        except Exception:
            return None

    @classmethod
    def _best_active_for_tenor(cls, insts: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        """Pick the current ACTIVE representative from instruments sharing a tenor.

        PSX lists many specific instruments per tenor, including ones that have
        already matured and nominal/un-traded rows (face_value '1', 0% coupon).
        Selection: keep only instruments maturing in the future; prefer "real"
        rows (face_value >= 1000 AND coupon > 0) so nominal placeholders are
        dropped; then take the farthest maturity (the on-the-run / most recently
        issued instrument). Falls back to any active row if none look "real".
        Returns None when no future-dated instrument exists.
        """
        today = date.today()
        active: List[tuple] = []
        for i in insts:
            m = cls._parse_maturity(i.get("maturity_date"))
            if m is None or m <= today:
                continue
            active.append((m, i))
        if not active:
            return None

        def _is_real(i: Dict[str, Any]) -> bool:
            fv, cr = i.get("face_value"), i.get("coupon_rate")
            try:
                return fv is not None and float(fv) >= 1000 and cr is not None and float(cr) > 0
            except (TypeError, ValueError):
                return False

        real = [(m, i) for (m, i) in active if _is_real(i)]
        pool = real if real else active
        pool.sort(key=lambda t: t[0], reverse=True)  # farthest maturity = on-the-run
        return pool[0][1]

    async def get_instrument(self, symbol: str) -> Optional[Dict[str, Any]]:
        """
        Return the full scraped debt record for a single instrument.

        Accepts either a raw PSX ``security_code`` (e.g. ``P05PIB040728``) or a
        friendly tenor key (e.g. ``MTB-3M``, ``PIB-5Y``). For a tenor key, the
        CURRENT ACTIVE representative is selected (never a matured/nominal row).
        Cached in Redis for 24h. Returns ``None`` when no match is found.
        """
        import json

        su = symbol.strip().upper()
        cache_key = f"market:psx:debt_instrument:{su}"

        # 1. Redis cache (24h)
        try:
            from app.core.redis import redis_client
            raw = await redis_client.get(cache_key)
            if raw:
                return json.loads(raw)
        except Exception:
            pass

        all_inst = await self.fetch_all_instruments()

        found: Optional[Dict[str, Any]] = None
        # Direct security_code match (covers raw codes + corporate TFCs/Sukuk).
        for inst in all_inst:
            if (inst.get("security_code") or "").upper() == su:
                found = inst
                break
        # Friendly tenor key match (MTB-3M, PIB-5Y, …): choose the current active
        # representative, never the first (often matured/nominal) row.
        if found is None:
            tenor_matches = [inst for inst in all_inst if self._tenor_key(inst) == su]
            found = self._best_active_for_tenor(tenor_matches)

        if found is not None:
            try:
                from app.core.redis import redis_client
                await redis_client.setex(cache_key, 86400, json.dumps(found, default=str))
            except Exception:
                pass

        return found

    async def fetch_govt_securities(self) -> Dict[str, Dict[str, Any]]:
        """
        Fetch only government debt securities (PIBs + T-Bills).
        Returns dict keyed by security_code.
        """
        all_inst = await self.fetch_all_instruments()
        return {
            inst["security_code"]: inst
            for inst in all_inst
            if inst["category"] == "govt_debt"
        }

    @staticmethod
    def _yield_key(inst: Dict[str, Any]) -> Optional[str]:
        """Tenor key for yield reporting: PIB-nY from govt debt, GIS-nY-FRR/VRR
        from GoP Ijarah Sukuk codes (P03FRR…, P05VRR…). T-bills never get a key —
        they are discount instruments listed at 0% coupon, so the page carries
        no yield for them (SBP auction cut-offs supply those)."""
        code = (inst.get("security_code") or "").upper()
        if inst.get("category") == "gop_sukuk":
            m = re.match(r"P(\d{2})(FRR|VRR)", code)
            return f"GIS-{int(m.group(1))}Y-{m.group(2)}" if m else None
        if inst.get("category") != "govt_debt" or code.startswith("PK"):
            return None
        m = re.match(r"P(\d{2})P(?:IB|FL)", code)  # P10PIB… fixed, P10PFL… floater
        return f"PIB-{int(m.group(1))}Y" if m else None

    async def fetch_yields_by_tenor(self) -> Dict[str, Decimal]:
        """
        Representative yield per tenor from the PSX debt market page, e.g.
        {"PIB-10Y": Decimal("0.1250"), "GIS-3Y-FRR": Decimal("0.12"), ...}.

        Per tenor: the most recently ISSUED instrument that has not matured and
        carries a non-zero coupon/rental rate (the on-the-run issue, whose rate
        reflects current market levels). No T-bill keys — see ``_yield_key``.
        Returns {} when the page can't be scraped; never fabricates a rate.
        """
        today = date.today()
        best: Dict[str, tuple] = {}
        for inst in await self.fetch_all_instruments():
            key = self._yield_key(inst)
            rate = inst.get("coupon_rate")
            if key is None or rate is None or rate <= 0:
                continue
            maturity = self._parse_maturity(inst.get("maturity_date"))
            if maturity is None or maturity <= today:
                continue
            issued = self._parse_maturity(inst.get("issue_date")) or date.min
            if key not in best or issued > best[key][0]:
                best[key] = (issued, rate)
        return {k: Decimal(str(rate)) for k, (_, rate) in best.items()}
