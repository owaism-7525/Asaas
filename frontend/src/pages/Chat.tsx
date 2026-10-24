import { useEffect, useMemo } from 'react'
import { useLocation } from 'react-router-dom'
import { useChat } from '@/hooks/useChat'
import { ChatShell } from '@/components/chat/ChatShell'
import { usePortfolio } from '@/lib/queries'

interface LocationState {
  seedMessage?: string
}

/** Build suggestion chips from the user's actual holdings (falls back to
 *  generic examples in MessageList when there's no portfolio). */
function buildChips(holdings: { symbol?: string; asset_class?: string }[]): string[] {
  const sym = (h?: { symbol?: string }) => (h?.symbol ?? '').replace('.KA', '')
  const isStock = (h: { symbol?: string; asset_class?: string }) =>
    (h.asset_class ?? '').includes('stock') || (h.symbol ?? '').endsWith('.KA')
  const stock = holdings.find(isStock)
  const tbill = holdings.find((h) => ['tbill', 'bond'].includes(h.asset_class ?? ''))
  const crypto = holdings.find((h) => h.asset_class === 'crypto')

  const chips: string[] = ['How is my portfolio doing and what should I improve?']
  if (stock) { chips.push(`Value ${sym(stock)} for me`); chips.push(`Show RSI for ${sym(stock)}`) }
  if (tbill && chips.length < 4) chips.push(`How does the SBP rate affect my ${sym(tbill)}?`)
  if (crypto && chips.length < 4) chips.push(`Show RSI for ${sym(crypto)}`)
  if (chips.length < 4) chips.push("What's the market sentiment for my holdings?")
  return chips.slice(0, 4)
}

export default function ChatPage() {
  const { messages, isStreaming, activeTool, send, loadHistory } = useChat()
  const location = useLocation()
  const state = location.state as LocationState | null
  // Portfolio-aware suggestion chips (generic chips when there's no portfolio).
  const holdings = usePortfolio().data?.holdings
  const chips = useMemo(() => (holdings?.length ? buildChips(holdings) : undefined), [holdings])

  useEffect(() => {
    loadHistory().then(() => {
      if (state?.seedMessage) {
        send(state.seedMessage)
        window.history.replaceState({}, '')
      }
    })    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Escape AppShell's content padding so the chat input sits flush at the bottom.
  // Height = viewport minus AppShell's sticky band (ticker h-7 + header h-14 = 5.25rem).
  return (
    <div
      className="flex flex-col -mx-4 -mt-6 -mb-20 md:-mb-6"
      style={{ height: 'calc(100dvh - 5.25rem)' }}
    >
      <ChatShell
        messages={messages}
        isStreaming={isStreaming}
        activeTool={activeTool}
        onSend={send}
        className="flex-1 min-h-0"
        chips={chips}
      />
    </div>
  )
}
