import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { User } from '@supabase/supabase-js'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { postSession, getProfile, getPortfolio } from '@/lib/api'
import { queryClient, qk } from '@/lib/queries'

interface AuthContextValue {
  user: User | null
  loading: boolean
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
  signOut: async () => {},
})

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()
  const syncingRef = useRef(false)
  const hasSyncedRef = useRef(false)

  const handleSignIn = useCallback(async () => {
    if (syncingRef.current) return
    syncingRef.current = true
    try {
      await postSession()
      hasSyncedRef.current = true
      queryClient.clear()  // never show a previous user's cached data

      // fetchQuery seeds the shared cache, so the page we route to renders
      // from these results instead of fetching them again.
      try {
        await queryClient.fetchQuery({ queryKey: qk.profile, queryFn: getProfile })
      } catch (err) {
        if ((err as { status?: number }).status === 404) {
          navigate('/onboarding', { replace: true })
          return
        }
        return
      }

      try {
        await queryClient.fetchQuery({ queryKey: qk.portfolio, queryFn: getPortfolio })
        navigate('/dashboard', { replace: true })
      } catch (err) {
        if ((err as { status?: number }).status === 404) {
          navigate('/onboarding/suggest', { replace: true })
        }
      }
    } catch {
      // postSession failed — auth issue, do not redirect
    } finally {
      syncingRef.current = false
    }
  }, [navigate])

  useEffect(() => {
    // On mount: sync user state AND ensure local user row exists for existing sessions.
    // This handles page reloads where INITIAL_SESSION fires (not SIGNED_IN),
    // so handleSignIn() never runs — we call postSession() here instead.
    supabase.auth.getSession().then(async ({ data }) => {
      if (data.session && !hasSyncedRef.current) {
        try {
          await postSession()
          hasSyncedRef.current = true
        } catch {
          // Ignore — user state is still set; protected calls will surface the error
        }
      }
      setUser(data.session?.user ?? null)
      setLoading(false)
    })

    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT' || !session) {
        queryClient.clear()
        setUser(null)
        setLoading(false)
        hasSyncedRef.current = false
        return
      }

      setUser((prev) => (prev?.id === session.user.id ? prev : session.user))
      setLoading(false)

      // Only run the full sign-in flow (postSession + smart redirect) on a real
      // SIGNED_IN event that we haven't handled yet. This prevents the infinite
      // loop caused by Supabase firing SIGNED_IN from _recoverAndRefresh on
      // every tab-focus event.
      if (event === 'SIGNED_IN' && !hasSyncedRef.current) {
        handleSignIn()
      }
    })

    return () => listener.subscription.unsubscribe()
  }, [handleSignIn])

  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
  }, [])

  const value = useMemo(() => ({ user, loading, signOut }), [user, loading, signOut])

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
