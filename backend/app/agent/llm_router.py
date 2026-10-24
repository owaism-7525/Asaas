"""
Asaas (اثاثہ) — LLM Router

Task-based model routing with fallback chain.
Direct provider SDKs — no LangChain.

Tasks:
  light     → fast cheap model (intent classification, short answers)
  chat      → conversational quality
  reasoning → structured analysis
  hard      → best model (DCF, complex portfolio advice)
"""

from __future__ import annotations

import json
import logging

import httpx
from groq import AsyncGroq
from openai import AsyncOpenAI

from app.core.config import get_settings

logger = logging.getLogger("asaas.agent.llm_router")

# ── Lazy-initialised clients (avoid startup cost if keys missing) ─────────────

# Default per-request timeout (see TASK_TIMEOUTS for per-tier overrides). No SDK retries — the fallback chain is
# the retry, so a stuck provider costs at most 15s before the next one is tried
# (the OpenAI SDK default is a 10-minute wait + 2 retries).
_TIMEOUT = 15.0

_groq: AsyncGroq | None = None
_cerebras: AsyncOpenAI | None = None
_openrouter: AsyncOpenAI | None = None
_mistral: AsyncOpenAI | None = None


def _groq_client() -> AsyncGroq:
    global _groq
    if _groq is None:
        _groq = AsyncGroq(
            api_key=get_settings().groq_api_key, timeout=_TIMEOUT, max_retries=0,
        )
    return _groq


def _cerebras_client() -> AsyncOpenAI:
    global _cerebras
    if _cerebras is None:
        _cerebras = AsyncOpenAI(
            base_url="https://api.cerebras.ai/v1",
            api_key=get_settings().cerebras_api_key,
            timeout=_TIMEOUT,
            max_retries=0,
        )
    return _cerebras


def _openrouter_client() -> AsyncOpenAI:
    global _openrouter
    if _openrouter is None:
        _openrouter = AsyncOpenAI(
            base_url="https://openrouter.ai/api/v1",
            api_key=get_settings().openrouter_api_key,
            timeout=_TIMEOUT,
            max_retries=0,
        )
    return _openrouter


def _mistral_client() -> AsyncOpenAI:
    global _mistral
    if _mistral is None:
        _mistral = AsyncOpenAI(
            base_url="https://api.mistral.ai/v1",  # Mistral is OpenAI-compatible
            api_key=get_settings().mistral_api_key,
            timeout=_TIMEOUT,
            max_retries=0,
        )
    return _mistral


# ── Task → provider chain ─────────────────────────────────────────────────────

# Groq retired its Llama models (Oct 2026); gpt-oss-120b / qwen3.8 replace them.
# Groq-first on every tier (it is the provider that works today); Gemini is the
# second choice. `_chain()` then appends Mistral (only if MISTRAL_API_KEY is set)
# and the OpenRouter free slot as last resorts, and skips any provider whose key
# is empty or was rejected (401/403).
TASK_CHAINS: dict[str, list[dict]] = {
    "light": [  # intent classification + profiler — Groq Qwen is fastest
        {"provider": "groq",   "model": "qwen/qwen3.8-27b"},
        # Separate Groq rate-limit bucket: Qwen's free tier caps output at
        # 1000 tokens/min, so a 429 there falls to another Groq model first.
        {"provider": "groq",   "model": "openai/gpt-oss-20b"},
        {"provider": "gemini", "model": "gemini-2.5-flash"},
    ],
    "chat": [
        {"provider": "groq",   "model": "openai/gpt-oss-120b"},
        {"provider": "gemini", "model": "gemini-2.5-flash"},
    ],
    "reasoning": [
        {"provider": "groq",   "model": "openai/gpt-oss-120b"},
        {"provider": "gemini", "model": "gemini-2.5-flash"},
    ],
    "hard": [
        {"provider": "groq",   "model": "openai/gpt-oss-120b"},
        {"provider": "gemini", "model": "gemini-2.5-pro"},
    ],
}

# Per-tier request timeout. Hard (valuation) gets longer: Gemini Pro reasoning
# can exceed 15s. Everything else fails over fast.
TASK_TIMEOUTS: dict[str, float] = {"hard": 30.0}

# Per-tier output cap. Groq reserves max_tokens against the per-minute output
# budget, so light (one-word intents, short profiler turns) asks for less.
_MAX_TOKENS = 1024
TASK_MAX_TOKENS: dict[str, int] = {"light": 512}

_MISTRAL_FALLBACK = {"provider": "mistral", "model": "mistral-small-latest"}
_OPENROUTER_FALLBACK = {"provider": "openrouter", "model": "google/gemma-4-31b-it:free"}

_KEY_SETTING = {
    "groq": "groq_api_key",
    "gemini": "gemini_api_key",
    "cerebras": "cerebras_api_key",
    "openrouter": "openrouter_api_key",
    "mistral": "mistral_api_key",
}

# Providers whose key was rejected (401/403) this process. Keys only change on
# restart, so a rejected provider is skipped like a missing key from then on.
_rejected: set[str] = set()


class ProviderAuthError(Exception):
    """A provider rejected its API key (HTTP 401/403)."""

    def __init__(self, provider: str, status_code: int, detail: str = ""):
        super().__init__(f"{provider} rejected API key ({status_code}) {detail}".strip())
        self.status_code = status_code


def _has_key(provider: str) -> bool:
    return bool(getattr(get_settings(), _KEY_SETTING[provider], ""))


def _timeout(task: str) -> float:
    return TASK_TIMEOUTS.get(task, _TIMEOUT)


def _max_tokens(task: str) -> int:
    return TASK_MAX_TOKENS.get(task, _MAX_TOKENS)


def _chain(task: str) -> list[dict]:
    """Provider chain for a task: tier chain + optional fallbacks, minus providers
    with no key or a rejected key."""
    candidates = TASK_CHAINS.get(task, TASK_CHAINS["chat"]) + [_MISTRAL_FALLBACK, _OPENROUTER_FALLBACK]
    usable = []
    for cfg in candidates:
        if not _has_key(cfg["provider"]):
            logger.debug("LLM skip %s/%s: no API key", cfg["provider"], cfg["model"])
        elif cfg["provider"] in _rejected:
            logger.debug("LLM skip %s/%s: API key rejected", cfg["provider"], cfg["model"])
        else:
            usable.append(cfg)
    return usable


def _note_failure(provider: str, exc: Exception) -> None:
    """Disable a provider for the rest of the process if it rejected its key."""
    if getattr(exc, "status_code", None) in (401, 403) and provider not in _rejected:
        _rejected.add(provider)
        logger.warning("LLM provider %s rejected its API key — skipping it until restart", provider)


# ── Public API ────────────────────────────────────────────────────────────────

async def call_llm(task: str, system_prompt: str, user_message: str) -> str:
    """
    Call the LLM chain for a given task type.
    Tries each provider in order; falls back on any exception.
    Returns the full text response.
    """
    chain = _chain(task)
    timeout = _timeout(task)
    max_tokens = _max_tokens(task)
    last_error: Exception | None = None

    for cfg in chain:
        try:
            result = await _call_provider(cfg["provider"], cfg["model"], system_prompt, user_message, timeout, max_tokens)
            if result:
                logger.info("LLM ok: %s/%s task=%s", cfg["provider"], cfg["model"], task)
                return result
        except Exception as exc:
            last_error = exc
            _note_failure(cfg["provider"], exc)
            logger.warning("LLM failed %s/%s: %s", cfg["provider"], cfg["model"], exc)

    raise RuntimeError(f"All providers failed for task={task}. Last error: {last_error}")


async def call_llm_stream(task: str, system_prompt: str, user_message: str):
    """
    Async generator — yields text chunks as they stream from the LLM.
    Tries each provider in order; falls back on any exception.
    """
    chain = _chain(task)
    timeout = _timeout(task)
    max_tokens = _max_tokens(task)
    last_error: Exception | None = None

    for cfg in chain:
        try:
            async for chunk in _stream_provider(cfg["provider"], cfg["model"], system_prompt, user_message, timeout, max_tokens):
                yield chunk
            return
        except Exception as exc:
            last_error = exc
            _note_failure(cfg["provider"], exc)
            logger.warning("Stream failed %s/%s: %s", cfg["provider"], cfg["model"], exc)

    raise RuntimeError(f"All streaming providers failed for task={task}. Last error: {last_error}")


# ── Internal dispatch ─────────────────────────────────────────────────────────

async def _call_provider(provider: str, model: str, system: str, user: str, timeout: float, max_tokens: int) -> str | None:
    if provider == "groq":
        return await _call_groq(model, system, user, timeout, max_tokens)
    if provider == "cerebras":
        return await _call_openai_compat(_cerebras_client(), model, system, user, timeout, max_tokens)
    if provider == "openrouter":
        return await _call_openai_compat(_openrouter_client(), model, system, user, timeout, max_tokens)
    if provider == "mistral":
        return await _call_openai_compat(_mistral_client(), model, system, user, timeout, max_tokens)
    if provider == "gemini":
        return await _call_gemini(model, system, user, timeout)
    raise ValueError(f"Unknown provider: {provider}")


async def _stream_provider(provider: str, model: str, system: str, user: str, timeout: float, max_tokens: int):
    if provider == "groq":
        async for chunk in _stream_groq(model, system, user, timeout, max_tokens):
            yield chunk
    elif provider == "cerebras":
        async for chunk in _stream_openai_compat(_cerebras_client(), model, system, user, timeout, max_tokens):
            yield chunk
    elif provider == "openrouter":
        async for chunk in _stream_openai_compat(_openrouter_client(), model, system, user, timeout, max_tokens):
            yield chunk
    elif provider == "mistral":
        async for chunk in _stream_openai_compat(_mistral_client(), model, system, user, timeout, max_tokens):
            yield chunk
    elif provider == "gemini":
        async for chunk in _stream_gemini(model, system, user, timeout):
            yield chunk
    else:
        raise ValueError(f"Unknown provider: {provider}")


# ── Groq ──────────────────────────────────────────────────────────────────────

async def _call_groq(model: str, system: str, user: str, timeout: float, max_tokens: int) -> str:
    resp = await _groq_client().chat.completions.create(
        model=model,
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
        temperature=0.2,
        max_tokens=max_tokens,
        timeout=timeout,
    )
    return resp.choices[0].message.content or ""


async def _stream_groq(model: str, system: str, user: str, timeout: float, max_tokens: int):
    stream = await _groq_client().chat.completions.create(
        model=model,
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
        temperature=0.2,
        max_tokens=max_tokens,
        stream=True,
        timeout=timeout,
    )
    async for chunk in stream:
        delta = chunk.choices[0].delta.content
        if delta:
            yield delta


# ── OpenAI-compatible (Cerebras, OpenRouter) ──────────────────────────────────

async def _call_openai_compat(client: AsyncOpenAI, model: str, system: str, user: str, timeout: float, max_tokens: int) -> str:
    resp = await client.chat.completions.create(
        model=model,
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
        temperature=0.2,
        max_tokens=max_tokens,
        timeout=timeout,
    )
    return resp.choices[0].message.content or ""


async def _stream_openai_compat(client: AsyncOpenAI, model: str, system: str, user: str, timeout: float, max_tokens: int):
    stream = await client.chat.completions.create(
        model=model,
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
        temperature=0.2,
        max_tokens=max_tokens,
        stream=True,
        timeout=timeout,
    )
    async for chunk in stream:
        delta = chunk.choices[0].delta.content
        if delta:
            yield delta


# ── Gemini (REST API — native async, proper system_instruction) ───────────────

async def _call_gemini(model: str, system: str, user: str, timeout: float) -> str | None:
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
        f"?key={get_settings().gemini_api_key}"
    )
    payload = {
        "system_instruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": [{"text": user}]}],
        "generationConfig": {"temperature": 0.2},
    }
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(url, json=payload)
        if resp.status_code == 200:
            data = resp.json()
            try:
                return data["candidates"][0]["content"]["parts"][0]["text"]
            except (KeyError, IndexError) as exc:
                logger.error("Gemini response shape error: %s", exc)
                return None
        if resp.status_code in (401, 403):
            raise ProviderAuthError("gemini", resp.status_code)
        logger.error("Gemini API %d: %s", resp.status_code, resp.text[:200])
        return None


async def _stream_gemini(model: str, system: str, user: str, timeout: float):
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent"
        f"?key={get_settings().gemini_api_key}&alt=sse"
    )
    payload = {
        "system_instruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": [{"text": user}]}],
        "generationConfig": {"temperature": 0.2},
    }
    async with httpx.AsyncClient(timeout=timeout) as client:
        async with client.stream("POST", url, json=payload) as resp:
            # A non-200 stream body is an error document, not SSE — raise so the
            # chain falls through instead of "succeeding" with zero chunks.
            if resp.status_code in (401, 403):
                raise ProviderAuthError("gemini", resp.status_code)
            if resp.status_code != 200:
                raise RuntimeError(f"Gemini stream HTTP {resp.status_code}")
            async for line in resp.aiter_lines():
                if line.startswith("data: "):
                    try:
                        data = json.loads(line[6:])
                        text = data["candidates"][0]["content"]["parts"][0]["text"]
                        if text:
                            yield text
                    except (KeyError, IndexError, json.JSONDecodeError):
                        pass
