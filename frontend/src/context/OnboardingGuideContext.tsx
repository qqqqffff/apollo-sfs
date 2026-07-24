import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { meQueryOptions } from '../api/me'
import { OnboardingSpotlightTour } from '../components/OnboardingSpotlightTour'
import { BASE_GUIDE_STEPS, PREMIUM_GUIDE_STEPS } from '../data/onboardingGuides'

export type GuideKind = 'base' | 'premium'

// Seen-flags are plain localStorage, namespaced by username — same pattern
// as the API key guide's dismissal flag (see _auth.settings/api-keys.tsx),
// just keyed per-account so switching users on a shared browser doesn't
// carry one account's "already seen" state into another's.
function seenKey(kind: GuideKind, username: string): string {
  return `apollo_onboarding_${kind}_seen_${username}`
}

function hasSeen(kind: GuideKind, username: string): boolean {
  return localStorage.getItem(seenKey(kind, username)) === '1'
}

function markSeen(kind: GuideKind, username: string): void {
  localStorage.setItem(seenKey(kind, username), '1')
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
  const [activeGuide, setActiveGuide] = useState<GuideKind | null>(null)
  const isPremium = !!(user?.is_premium || user?.is_admin)

  // Auto-open the base guide the first time an account is seen in this
  // browser, then — once it's dismissed — chain straight into the premium
  // guide for premium accounts that haven't seen it yet. This also covers
  // "first premium purchase": buying premium flips `is_premium` on the next
  // `me` refetch, which this effect picks up the same way it would for an
  // account that was already premium on login.
  useEffect(() => {
    if (!user || activeGuide) return
    if (!hasSeen('base', user.username)) {
      setActiveGuide('base')
    } else if (isPremium && !hasSeen('premium', user.username)) {
      setActiveGuide('premium')
    }
  }, [user, isPremium, activeGuide])

  function closeGuide(kind: GuideKind) {
    if (user) markSeen(kind, user.username)
    setActiveGuide(null)
    if (kind === 'base' && user && isPremium && !hasSeen('premium', user.username)) {
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
