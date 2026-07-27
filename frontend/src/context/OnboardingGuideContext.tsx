import { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { meQueryOptions, preferencesQueryOptions, markOnboardingGuideSeen } from '../api/me'
import type { UserPreferences } from '../types/api'
import { OnboardingSpotlightTour } from '../components/OnboardingSpotlightTour'
import { BASE_GUIDE_STEPS, PREMIUM_GUIDE_STEPS } from '../data/onboardingGuides'

export type GuideKind = 'base' | 'premium'

// Seen-flags live on the account (user_preferences.onboarding_*_seen), not in
// localStorage. They used to be localStorage keys namespaced by username,
// which meant "first login" was really "first login in this browser profile":
// a new browser, a new device, private browsing, or any "clear site data on
// close" setting replayed the whole tour on the next sign-in. Persisting them
// server-side makes "first login" and "first time premium is active" account
// facts, so each guide auto-plays exactly once per account, ever.
function hasSeen(kind: GuideKind, prefs: UserPreferences): boolean {
  return kind === 'base' ? prefs.onboarding_base_seen : prefs.onboarding_premium_seen
}

interface OnboardingGuideContextValue {
  // Opens a guide on demand, bypassing the seen-flag — used by the "Replay
  // guide" links on the Profile page. Auto-triggering (first login, first
  // premium purchase) is handled internally by the provider.
  openGuide: (kind: GuideKind) => void
}

const OnboardingGuideContext = createContext<OnboardingGuideContextValue | null>(null)

export function useOnboardingGuide(): OnboardingGuideContextValue {
  const ctx = useContext(OnboardingGuideContext)
  if (!ctx) throw new Error('useOnboardingGuide must be used within OnboardingGuideProvider')
  return ctx
}

export function OnboardingGuideProvider({ children }: { children: ReactNode }) {
  const { data: user } = useQuery(meQueryOptions)
  const { data: prefs } = useQuery(preferencesQueryOptions)
  const queryClient = useQueryClient()
  const [activeGuide, setActiveGuide] = useState<GuideKind | null>(null)
  const isPremium = !!(user?.is_premium || user?.is_admin)

  // Guards the window between dismissing a guide and the PUT below landing:
  // until the server round-trip finishes, a refetch of the preferences query
  // can still return the stale `false` and re-trigger the auto-open effect.
  // A ref rather than state — it must never itself cause a re-render.
  const dismissed = useRef<Set<GuideKind>>(new Set())

  // Auto-open the base guide the first time an account signs in, then — once
  // it's dismissed — chain straight into the premium guide for premium
  // accounts that haven't seen it yet. This also covers "first premium
  // purchase": buying premium flips `is_premium` on the next `me` refetch,
  // which this effect picks up the same way it would for an account that was
  // already premium on login. Waits for `prefs` so nothing flashes before the
  // seen-flags are known.
  useEffect(() => {
    if (!user || !prefs || activeGuide) return
    if (!hasSeen('base', prefs) && !dismissed.current.has('base')) {
      setActiveGuide('base')
    } else if (isPremium && !hasSeen('premium', prefs) && !dismissed.current.has('premium')) {
      setActiveGuide('premium')
    }
  }, [user, prefs, isPremium, activeGuide])

  function closeGuide(kind: GuideKind) {
    dismissed.current.add(kind)
    setActiveGuide(null)
    // Fire-and-forget: a failed write only costs the user seeing the guide
    // once more on a later login, so there's nothing useful to surface here.
    // The response is the full updated preferences row, so it seeds the cache
    // directly instead of forcing a refetch.
    markOnboardingGuideSeen(kind)
      .then((updated) => queryClient.setQueryData(preferencesQueryOptions.queryKey, updated))
      .catch(() => {})
    if (kind === 'base' && prefs && isPremium && !hasSeen('premium', prefs) && !dismissed.current.has('premium')) {
      setActiveGuide('premium')
    }
  }

  function openGuide(kind: GuideKind) {
    setActiveGuide(kind)
  }

  return (
    <OnboardingGuideContext.Provider value={{ openGuide }}>
      {children}
      {activeGuide === 'base' && (
        <OnboardingSpotlightTour
          eyebrow="Getting started"
          steps={BASE_GUIDE_STEPS}
          onClose={() => closeGuide('base')}
        />
      )}
      {activeGuide === 'premium' && (
        <OnboardingSpotlightTour
          eyebrow="Premium features"
          steps={PREMIUM_GUIDE_STEPS}
          onClose={() => closeGuide('premium')}
        />
      )}
    </OnboardingGuideContext.Provider>
  )
}
