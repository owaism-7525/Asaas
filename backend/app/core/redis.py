"""
Asaas (اثاثہ) — Redis Client

Provides shared, asynchronous access to Redis for rate-limiting,
caching, and guest tracking.

Redis is an optimisation, never a dependency: when it is unreachable every
command becomes a no-op returning ``None`` (a cache miss), so callers fall
through to the live source — slow-but-working instead of erroring.
"""

from __future__ import annotations

import logging
import time

from redis.asyncio import Redis
from redis.asyncio.retry import Retry
from redis.backoff import NoBackoff
from redis.exceptions import ConnectionError as RedisConnectionError
from redis.exceptions import TimeoutError as RedisTimeoutError

from app.core.config import get_settings

logger = logging.getLogger("asaas.redis")

settings = get_settings()

# After a connection failure, skip Redis entirely for this long instead of
# paying a connect timeout on every cache call.
_RETRY_AFTER = 30.0


class FailSafeRedis(Redis):
    """Redis client whose commands degrade to ``None`` while Redis is down.

    Only connection/timeout errors are swallowed; real command errors still
    raise. PING always hits the server and raises, so health checks report
    the true state.
    """

    _down_until: float = 0.0
    _is_down: bool = False

    @property
    def available(self) -> bool:
        return not self._is_down

    def _mark_down(self, exc: Exception) -> None:
        if not self._is_down:
            logger.warning("Redis unreachable — running without cache (%s)", exc)
        self._is_down = True
        self._down_until = time.monotonic() + _RETRY_AFTER

    def _mark_up(self) -> None:
        if self._is_down:
            logger.warning("Redis reachable again — cache re-enabled")
        self._is_down = False

    async def execute_command(self, *args, **options):
        is_ping = bool(args) and str(args[0]).upper() == "PING"
        if self._is_down and not is_ping and time.monotonic() < self._down_until:
            return None
        try:
            result = await super().execute_command(*args, **options)
        except (RedisConnectionError, RedisTimeoutError, OSError) as exc:
            self._mark_down(exc)
            if is_ping:
                raise
            return None
        self._mark_up()
        return result


# Global async Redis client
redis_client: FailSafeRedis = FailSafeRedis.from_url(
    settings.redis_url,
    decode_responses=True,
    protocol=2,  # RESP2 — compatible with Redis 5.x (tporadowski Windows build)
    # Fail fast: one attempt, short timeouts — the breaker above handles outages.
    socket_connect_timeout=2,
    socket_timeout=3,
    retry=Retry(NoBackoff(), 0),
)


async def get_redis() -> Redis:
    """FastAPI dependency to retrieve the Redis client."""
    return redis_client
