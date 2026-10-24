"""
Asaas (اثاثہ) — Agent Orchestrator

LangGraph StateGraph:
  load_context → classify → [conditional routing] → role_node → END

PII abstraction runs in load_context before any LLM call (RULES.md A1.2).
Roles are bounded — one LLM call per role per turn (AGENT_RULES.md §7).
"""

from __future__ import annotations

import logging
from typing import Any, Dict
from uuid import UUID

from langgraph.graph import END, StateGraph
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.llm_router import call_llm
from app.agent.memory import format_history
from app.agent.prompts.pii_abstraction import abstract_context
from app.agent.roles.chat import run_chat
from app.agent.roles.market_sentiment import run_market_sentiment
from app.agent.roles.news_materiality import run_news_analyst
from app.agent.roles.optimizer import run_optimizer
from app.agent.roles.profiler import run_profiler
from app.agent.roles.rate_impact import run_rate_analyst
from app.agent.roles.technical import run_technical_analysis_role
from app.agent.roles.valuation import run_valuation
from app.agent.types import AgentState
from app.models.chat_message import ChatMessage
from app.models.holding import Holding
from app.models.instrument import Instrument
from app.models.portfolio import Portfolio
from app.models.risk_profile import RiskProfile
from app.models.user import User

logger = logging.getLogger("asaas.agent.orchestrator")

_VALID_INTENTS = frozenset(
    {"profile", "suggest", "diversification", "track", "news", "rate", "valuation",
     "technical", "market_sentiment", "general"}
)

# How many prior chat turns are loaded as conversation memory per request.
# ~8 exchanges — enough for the Profiler's two-step protocol and follow-up
# questions ("what about gold?") without bloating the LLM's token budget.
HISTORY_WINDOW = 16

_CLASSIFY_PROMPT = (
    "You are the intent classifier for ASAAS, an agentic wealth manager.\n"
    "Classify the user's message into exactly ONE of these labels:\n"
    "  profile         - user wants to define/update risk tolerance, goals, or constraints\n"
    "  suggest         - user wants a portfolio suggestion or re-optimisation\n"
    "  diversification - user asks about risk, sector exposure, or asset class limits\n"
    "  track           - user asks about current portfolio performance or value\n"
    "  news            - user asks about economic news, PSX announcements, or market events\n"
    "  rate            - user asks about SBP policy rate changes and their impact\n"
    "  valuation       - a question about a SPECIFIC INSTRUMENT the user could hold: a listed\n"
    "                    company/ticker (PSO, HBL, LUCK, OGDC), a commodity (gold, silver), a\n"
    "                    crypto (bitcoin/BTC, ethereum/ETH), or a govt security (T-bill, PIB,\n"
    "                    sukuk): value it, is it over/under-valued, its price/yield, run DCF, or\n"
    "                    'tell me about <instrument>', '<ticker> stock', 'analyse <X>'.\n"
    "                    NOT for general finance concepts/definitions — those are 'general'.\n"
    "  technical       - user asks for RSI, MACD, moving averages, golden/death cross, chart signals\n"
    "  market_sentiment- user asks about market mood/sentiment, whether the market is bullish/bearish,\n"
    "                    or how sentiment looks for a sector or asset class\n"
    "  general         - greetings, platform/how-to questions, and FINANCIAL EDUCATION: explaining\n"
    "                    concepts or terms (what is WACC, P/E, EPS, beta, DCF, diversification,\n"
    "                    mutual fund, T-bill), 'how does X work', or anything else\n"
    "Examples:\n"
    "  'tell me about PSO' -> valuation\n"
    "  'PSO stock' / 'analyse HBL' / 'is LUCK overvalued?' -> valuation\n"
    "  'DGKC ka P/E kya hai' -> valuation\n"
    "  'tell me about gold' / 'is bitcoin overvalued' / 'silver price' -> valuation\n"
    "  'value a 3-month T-bill' / 'tell me about a 5 year PIB' -> valuation\n"
    "  'what is WACC' / 'explain P/E ratio' / 'tell me about diversification' -> general\n"
    "  'how does DCF work' -> general\n"
    "  'suggest me a portfolio' -> suggest\n"
    "  'how is my portfolio doing' -> track\n"
    "Respond with the single label word only."
)


class AgentOrchestrator:
    """
    Manages the conversational routing, PII abstraction, and LangGraph execution.
    Public API: process_message(user_id, user_message) → str
    """

    def __init__(self, db: AsyncSession):
        self.db = db
        self._graph = self._build_graph()

    # ------------------------------------------------------------------
    # Graph construction
    # ------------------------------------------------------------------

    def _build_graph(self):
        """Build the LangGraph StateGraph with node closures capturing self.db."""
        db = self.db

        # ---- Node functions (closures) --------------------------------

        async def load_context_node(state: AgentState) -> AgentState:
            user_id = UUID(state["user_id"])

            user_res = await db.execute(select(User).where(User.id == user_id))
            user = user_res.scalar_one_or_none()
            if not user:
                state["context"] = {}
                state["portfolio_id"] = None
                state["history"] = []
                return state

            profile_res = await db.execute(
                select(RiskProfile).where(RiskProfile.user_id == user_id)
            )
            profile = profile_res.scalar_one_or_none()

            port_res = await db.execute(
                select(Portfolio)
                .where(
                    Portfolio.user_id == user_id,
                    Portfolio.status != "draft",
                )
                .order_by(Portfolio.confirmed_at.desc())
            )
            portfolio = port_res.scalars().first()

            holdings = []
            portfolio_id_str = None
            instruments: Dict[str, Any] = {}

            if portfolio:
                portfolio_id_str = str(portfolio.id)
                # Holdings + their instruments in one query (outer join keeps a
                # holding even if its instrument row is missing, as before).
                hold_res = await db.execute(
                    select(Holding, Instrument)
                    .outerjoin(Instrument, Instrument.id == Holding.instrument_id)
                    .where(Holding.portfolio_id == portfolio.id)
                )
                for h, inst in hold_res.all():
                    holdings.append(h)
                    if inst:
                        instruments[str(h.instrument_id)] = inst

            state["context"] = abstract_context(
                profile=profile,
                portfolio=portfolio,
                holdings=holdings,
                instruments=instruments,
            )
            state["portfolio_id"] = portfolio_id_str

            # Load recent conversation memory (newest last). Only role + content
            # is carried — tool_call payloads / absolute amounts stay out of the
            # LLM-bound history (RULES.md A1.2 abstraction discipline).
            #
            # Scope to the CURRENT conversation thread when one is supplied (the
            # Raabta AI widget), so a follow-up like "explain this" reads only
            # that thread's latest turns — not messages bleeding in from other
            # conversations. Falls back to user-wide history when no thread id is
            # given (the Chat page / useChat surface).
            conversation_id = state.get("conversation_id")
            hist_stmt = select(ChatMessage).order_by(ChatMessage.created_at.desc()).limit(HISTORY_WINDOW)
            if conversation_id:
                hist_stmt = hist_stmt.where(ChatMessage.conversation_id == UUID(conversation_id))
            else:
                hist_stmt = hist_stmt.where(ChatMessage.user_id == user_id)
            hist_res = await db.execute(hist_stmt)
            state["history"] = [
                {"role": m.role, "content": m.content}
                for m in reversed(hist_res.scalars().all())
            ]
            return state

        async def classify_node(state: AgentState) -> AgentState:
            # Show the classifier the last few turns so referent-following
            # messages ("what about gold?", "and its RSI?") route to the right
            # role instead of defaulting to general. Kept short on purpose —
            # classification is a light, cheap call.
            recent = format_history(state.get("history", [])[-6:])
            user_content = (
                f"{recent}\n\n" if recent else ""
            ) + (
                f"Message: '{state['user_message']}'\n"
                f"Context snapshot: has_profile={state['context'].get('has_profile')}, "
                f"has_portfolio={state['context'].get('has_portfolio')}"
            )
            try:
                raw = await call_llm(task="light", system_prompt=_CLASSIFY_PROMPT, user_message=user_content)
                label = raw.strip().lower().split()[0] if raw.strip() else "general"
                for valid in _VALID_INTENTS:
                    if valid in label:
                        state["intent"] = valid
                        return state
            except Exception as exc:
                logger.error("Intent classification failed: %s", exc)
            state["intent"] = "general"
            return state

        async def profiler_node(state: AgentState) -> AgentState:
            return await run_profiler(state=state, db=db)

        async def optimizer_node(state: AgentState) -> AgentState:
            return await run_optimizer(state=state, db=db)

        async def news_node(state: AgentState) -> AgentState:
            return await run_news_analyst(state=state, db=db)

        async def market_sentiment_node(state: AgentState) -> AgentState:
            return await run_market_sentiment(state=state, db=db)

        async def rate_node(state: AgentState) -> AgentState:
            return await run_rate_analyst(state=state, db=db)

        async def chat_node(state: AgentState) -> AgentState:
            return await run_chat(state=state, db=db)

        async def valuation_node(state: AgentState) -> AgentState:
            return await run_valuation(state=state, db=db)

        async def technical_node(state: AgentState) -> AgentState:
            return await run_technical_analysis_role(state=state, db=db)

        # ---- Routing --------------------------------------------------

        def route_intent(state: AgentState) -> str:
            intent = state.get("intent", "general")
            routes = {
                "profile": "profiler",
                "suggest": "optimizer",
                "diversification": "optimizer",
                "track": "optimizer",
                "news": "news",
                "rate": "rate",
                "valuation": "valuation",
                "technical": "technical",
                "market_sentiment": "market_sentiment",
                "general": "chat",
            }
            return routes.get(intent, "chat")

        # ---- Graph assembly -------------------------------------------

        workflow = StateGraph(AgentState)
        workflow.add_node("load_context", load_context_node)
        workflow.add_node("classify", classify_node)
        workflow.add_node("profiler", profiler_node)
        workflow.add_node("optimizer", optimizer_node)
        workflow.add_node("news", news_node)
        workflow.add_node("market_sentiment", market_sentiment_node)
        workflow.add_node("rate", rate_node)
        workflow.add_node("chat", chat_node)
        workflow.add_node("valuation", valuation_node)
        workflow.add_node("technical", technical_node)

        workflow.set_entry_point("load_context")
        workflow.add_edge("load_context", "classify")
        workflow.add_conditional_edges(
            "classify",
            route_intent,
            {
                "profiler": "profiler",
                "optimizer": "optimizer",
                "news": "news",
                "market_sentiment": "market_sentiment",
                "rate": "rate",
                "chat": "chat",
                "valuation": "valuation",
                "technical": "technical",
            },
        )
        workflow.add_edge("profiler", END)
        workflow.add_edge("optimizer", END)
        workflow.add_edge("news", END)
        workflow.add_edge("market_sentiment", END)
        workflow.add_edge("rate", END)
        workflow.add_edge("chat", END)
        workflow.add_edge("valuation", END)
        workflow.add_edge("technical", END)

        return workflow.compile()

    # ------------------------------------------------------------------
    # Public API (unchanged from Phase 0 skeleton)
    # ------------------------------------------------------------------

    _INTENT_TO_ROLE = {
        "profile": "profiler",
        "suggest": "optimizer",
        "diversification": "optimizer",
        "track": "optimizer",
        "news": "news_materiality",
        "market_sentiment": "market_sentiment",
        "rate": "rate_impact",
        "valuation": "valuation",
        "technical": "technical",
        "general": "chat",
    }

    async def process_message(
        self, user_id: UUID, user_message: str, conversation_id: UUID | None = None
    ) -> tuple[str, str]:
        """
        Entry point called by the chat API.
        Returns (response_text, agent_role). ``conversation_id`` scopes the
        loaded history to a single thread when provided.
        """
        initial_state: AgentState = {
            "user_id": str(user_id),
            "conversation_id": str(conversation_id) if conversation_id else None,
            "user_message": user_message,
            "intent": "",
            "context": {},
            "portfolio_id": None,
            "response": "",
            "history": [],
        }

        try:
            final_state = await self._graph.ainvoke(initial_state)
            text = final_state.get("response") or "I'm sorry, I didn't understand that. Please try again."
            role = self._INTENT_TO_ROLE.get(final_state.get("intent", "general"), "chat")
            return text, role
        except Exception as exc:
            logger.error("Graph execution failed for user %s: %s", user_id, exc)
            return (
                "I encountered an error processing your request. Please try again in a moment.",
                "chat",
            )
