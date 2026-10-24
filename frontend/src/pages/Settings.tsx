import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/context/AuthContext'
import { putProfile } from '@/lib/api'
import { queryClient, qk, useProfile } from '@/lib/queries'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { ProfileResponse } from '@/types/api'

const RISK_OPTIONS = [
  { value: 'conservative', label: 'Conservative' },
  { value: 'moderately_conservative', label: 'Moderately Conservative' },
  { value: 'moderate', label: 'Moderate' },
  { value: 'aggressive', label: 'Aggressive' },
  { value: 'very_aggressive', label: 'Very Aggressive' },
] as const

const HORIZON_OPTIONS = [
  { value: 'short', label: 'Short-term (< 2 years)' },
  { value: 'medium', label: 'Medium-term (2–7 years)' },
  { value: 'long', label: 'Long-term (7+ years)' },
] as const

const RISK_BADGE: Record<string, 'neutral' | 'info' | 'gold'> = {
  conservative: 'info',
  moderately_conservative: 'info',
  moderate: 'gold',
  aggressive: 'neutral',
  very_aggressive: 'neutral',
}

const RISK_LABEL = Object.fromEntries(RISK_OPTIONS.map((o) => [o.value, o.label]))
const HORIZON_LABEL = Object.fromEntries(HORIZON_OPTIONS.map((o) => [o.value, o.label]))

const fieldCls = cn(
  'bg-card border border-line rounded-[8px] px-3 py-2.5 text-[15px] text-ink w-full',
  'hover:border-ink-faint focus:border-jade focus-visible:outline-2 focus-visible:outline-jade focus-visible:outline-offset-2',
  'min-h-[44px]',
)

export default function Settings() {
  const navigate = useNavigate()
  const { user, signOut } = useAuth()
  const profile: ProfileResponse | null = useProfile().data ?? null

  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [editRisk, setEditRisk] = useState('')
  const [editHorizon, setEditHorizon] = useState('')
  const [editGoal, setEditGoal] = useState('')

  const startEdit = () => {
    if (!profile) return
    setEditRisk(profile.risk_tolerance)
    setEditHorizon(profile.horizon)
    setEditGoal(profile.goal ?? '')
    setSaveError(null)
    setEditing(true)
  }

  const cancelEdit = () => {
    setEditing(false)
    setSaveError(null)
  }

  const handleSave = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      const updated = await putProfile({
        risk_tolerance: editRisk as ProfileResponse['risk_tolerance'],
        horizon: editHorizon as ProfileResponse['horizon'],
        goal: editGoal,
      })
      queryClient.setQueryData(qk.profile, updated)
      setEditing(false)
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Failed to save. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  const handleSignOut = async () => {
    await signOut()
    navigate('/', { replace: true })
  }

  return (
    <div className="flex flex-col gap-8 max-w-lg">
      <h1 className="font-display text-[28px] font-semibold text-ink">Settings</h1>

      {/* Risk profile */}
      <section className="flex flex-col gap-4">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-faint">
          Risk profile
        </h2>

        {profile ? (
          editing ? (
            <div className="bg-card border border-line rounded-[10px] p-5 flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <label className="font-sans text-[13px] font-medium text-ink">Risk tolerance</label>
                <select
                  value={editRisk}
                  onChange={(e) => setEditRisk(e.target.value)}
                  className={fieldCls}
                >
                  {RISK_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="font-sans text-[13px] font-medium text-ink">Investment horizon</label>
                <select
                  value={editHorizon}
                  onChange={(e) => setEditHorizon(e.target.value)}
                  className={fieldCls}
                >
                  {HORIZON_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="font-sans text-[13px] font-medium text-ink">Investment goal</label>
                <input
                  type="text"
                  value={editGoal}
                  onChange={(e) => setEditGoal(e.target.value)}
                  placeholder="e.g. Retirement, house purchase…"
                  maxLength={120}
                  className={fieldCls}
                />
              </div>

              {saveError && (
                <p className="font-sans text-[13px] text-loss" role="alert">{saveError}</p>
              )}

              <div className="flex gap-3 mt-1">
                <Button
                  variant="primary"
                  onClick={handleSave}
                  disabled={saving}
                  className="flex-1"
                >
                  {saving ? 'Saving…' : 'Save changes'}
                </Button>
                <Button variant="ghost" onClick={cancelEdit} disabled={saving}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="bg-card border border-line rounded-[10px] p-5 flex flex-col gap-4">
              <div className="flex items-center gap-3 flex-wrap">
                <Badge variant={RISK_BADGE[profile.risk_tolerance] ?? 'neutral'}>
                  {RISK_LABEL[profile.risk_tolerance] ?? profile.risk_tolerance}
                </Badge>
                {profile.goal && <Badge variant="neutral">{profile.goal}</Badge>}
                <Badge variant="neutral">{HORIZON_LABEL[profile.horizon] ?? profile.horizon} horizon</Badge>
              </div>
              <div className="flex gap-3 flex-wrap">
                <Button variant="ghost" onClick={startEdit} className="self-start">
                  Edit profile
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => navigate('/onboarding')}
                  className="self-start"
                >
                  Re-take questionnaire
                </Button>
              </div>
            </div>
          )
        ) : (
          <div className="bg-card border border-line rounded-[10px] p-5">
            <p className="font-sans text-[14px] text-ink-faint">
              No profile yet.{' '}
              <button
                type="button"
                onClick={() => navigate('/onboarding')}
                className="text-jade hover:underline focus-visible:outline-2 focus-visible:outline-jade rounded"
              >
                Complete onboarding
              </button>
            </p>
          </div>
        )}
      </section>

      <hr className="border-line" />

      {/* Account */}
      <section className="flex flex-col gap-4">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-faint">Account</h2>
        <div className="bg-card border border-line rounded-[10px] p-5 flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-faint">Email</span>
            <span className="font-sans text-[15px] text-ink">{user?.email ?? '—'}</span>
          </div>
          <Button
            variant="ghost"
            onClick={handleSignOut}
            className="self-start text-loss hover:text-loss"
          >
            Sign out
          </Button>
        </div>
      </section>

      <hr className="border-line" />

      {/* Display */}
      <section className="flex flex-col gap-4">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-faint">Display</h2>
        <div className="bg-card border border-line rounded-[10px] p-5">
          <p className="font-sans text-[14px] text-ink-faint">Display preferences — coming soon.</p>
        </div>
      </section>
    </div>
  )
}
