import { Outlet, Link } from 'react-router-dom'
import { User, Sun, Moon } from 'lucide-react'
import { useAuth } from '@/context/AuthContext'
import { useTheme } from '@/context/ThemeContext'
import { NavBar } from './NavBar'
import { MarketTicker } from './MarketTicker'
import { RaabtaAI } from './RaabtaAI'
import { useFlags } from '@/lib/queries'
import { cn } from '@/lib/utils'

export function AppShell() {
  const { user } = useAuth()
  const { theme, toggleTheme } = useTheme()
  const flagCount = (useFlags().data ?? []).filter((f) => !f.dismissed).length

  const initials = user?.email?.slice(0, 2).toUpperCase() ?? '??'

  return (
    <div className="min-h-screen bg-paper flex flex-col">
      {/* Sticky band: ticker + nav together so both stay at the top on scroll */}
      <div className="sticky top-0 z-40">
        <MarketTicker />

      {/* Top navigation bar — glassmorphism: translucent, blurred, hairline edge */}
      <header className="bg-card/70 backdrop-blur-xl border-b border-line/60 supports-[backdrop-filter]:bg-card/60">
        <div className="max-w-5xl mx-auto px-4 flex items-center justify-between h-14">
          {/* Wordmark */}
          <Link
            to="/dashboard"
            className="flex items-center gap-2 focus-visible:outline-2 focus-visible:outline-jade focus-visible:outline-offset-2 rounded"
          >
            <img src="/logo.png" alt="Asaasa" className="h-8 w-auto" />
            <span className="font-display text-[18px] font-semibold text-ink hidden sm:block">اثاثہ</span>
          </Link>

          {/* Desktop nav */}
          <NavBar flagCount={flagCount} variant="top" />

          <div className="flex items-center gap-2">
            {/* Theme toggle */}
            <button
              type="button"
              onClick={toggleTheme}
              className={cn(
                'w-8 h-8 rounded-full border border-line flex items-center justify-center text-ink-soft',
                'hover:text-ink hover:border-jade/40 transition-colors',
                'focus-visible:outline-2 focus-visible:outline-jade focus-visible:outline-offset-2',
              )}
              aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
            >
              {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
            </button>

            {/* Avatar */}
            <Link
              to="/settings"
              className={cn(
                'w-8 h-8 rounded-full bg-jade text-white flex items-center justify-center',
                'font-mono text-[11px] font-semibold uppercase',
                'focus-visible:outline-2 focus-visible:outline-jade focus-visible:outline-offset-2',
                'hover:bg-jade-dark transition-colors',
              )}
              aria-label="Settings"
            >
              {user?.email ? initials : <User size={14} />}
            </Link>
          </div>
        </div>
      </header>
      </div>{/* end sticky band */}

      {/* Page content */}
      <main className="flex-1 max-w-5xl mx-auto w-full px-4 py-6 pb-20 md:pb-6">
        <Outlet />
      </main>

      {/* Mobile bottom tab bar */}
      <NavBar flagCount={flagCount} variant="bottom" />

      {/* Raabta AI — floating assistant on every page */}
      <RaabtaAI />
    </div>
  )
}
