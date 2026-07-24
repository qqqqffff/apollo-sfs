import type { ReactNode } from 'react'
import { MdAlternateEmail, MdBolt, MdKey, MdLink, MdPhotoLibrary, MdRocketLaunch, MdStar, MdSync } from 'react-icons/md'

export interface TourStep {
  title: string
  body: ReactNode
  // Matches a `data-tour="<target>"` attribute on the element to spotlight.
  // If the element can't be found (wrong breakpoint, not yet loaded), the
  // tour falls back to a plain dimmed overlay with a centered tooltip
  // instead of getting stuck — see OnboardingSpotlightTour.
  target: string
  // Route to navigate to before locating `target`, for steps that highlight
  // something on a page other than wherever the tour was opened from. Omit
  // when the target is on every authenticated page (e.g. the nav bar).
  route?: string
  // The target lives inside the files control panel, which collapses into a
  // slide-in drawer below the `lg` breakpoint — see OnboardingSpotlightTour,
  // which opens it via the sidebar toggle before locating this target.
  needsSidebar?: boolean
}

// BASE_GUIDE_STEPS walks every account through the features available on
// the free tier. Shown once per account (see OnboardingGuideContext) and
// replayable anytime from the Profile page.
export const BASE_GUIDE_STEPS: TourStep[] = [
  {
    target: 'brand',
    title: 'Welcome to Apollo SFS',
    body: (
      <p className="m-0">
        Your own encrypted file storage — upload, organize, and share files, all protected
        end-to-end. This quick tour points out the essentials. Step through it with the toolbar
        below, or skip it anytime.
      </p>
    ),
  },
  {
    target: 'upload-button',
    route: '/client',
    title: 'Upload your files',
    body: (
      <p className="m-0">
        Click <span className="font-medium">Upload</span>, or just drag and drop files anywhere on
        this page, to add them to your storage. Everything is encrypted before it ever leaves your
        device.
      </p>
    ),
  },
  {
    target: 'search-bar',
    route: '/client',
    title: 'Find anything fast',
    body: (
      <p className="m-0">
        Search across your files by name right from here — no need to dig through folders. Share
        links and favorites are managed from the file browser too.
      </p>
    ),
  },
  {
    target: 'storage-bar',
    route: '/client/profile',
    title: 'Storage usage and tiers',
    body: (
      <p className="m-0">
        This bar shows exactly how much of your quota you&rsquo;ve used, with a one-click way to
        add more. Apollo SFS spreads storage across a fast tier and a standard tier — pick the
        right one for hot files versus cold archives.
      </p>
    ),
  },
  {
    target: 'account-type',
    route: '/client/profile',
    title: 'Your profile and account',
    body: (
      <p className="m-0">
        The Profile page is home base for your account: linked sign-in providers, order history,
        password changes, and the preferences that control how storage prompts show up.
      </p>
    ),
  },
  {
    target: 'profile-chip',
    title: 'Want more?',
    body: (
      <p className="m-0">
        Premium unlocks the SFS API, AI-powered photo recognition, network-drive mounts, and more.
        Upgrade anytime from your Profile page — your account badge shows up right here once you
        do.
      </p>
    ),
  },
  {
    target: 'guides-card',
    route: '/client/profile',
    title: "That's the tour",
    body: (
      <p className="m-0">
        You&rsquo;re ready to go. Replay this guide anytime from the Guides section right here on
        your Profile page.
      </p>
    ),
  },
]

// PREMIUM_GUIDE_STEPS is shown once to every premium account — either the
// first time it's shown to an existing subscriber, or immediately after a
// user's first premium purchase (see OnboardingGuideContext) — and is
// replayable anytime from the Profile page.
export const PREMIUM_GUIDE_STEPS: TourStep[] = [
  {
    target: 'profile-chip',
    title: "You're on Premium",
    body: (
      <p className="m-0 flex items-start gap-2">
        <MdRocketLaunch className="text-amber-500 shrink-0 mt-0.5" />
        <span>
          Your account now carries the Premium badge — right here next to your username. This
          short tour highlights what it unlocks; skip it anytime or replay it later from your
          Profile page.
        </span>
      </p>
    ),
  },
  {
    target: 'sidebar-email-backup',
    route: '/client',
    needsSidebar: true,
    title: 'Back up automatically',
    body: (
      <p className="m-0 flex items-start gap-2">
        <MdAlternateEmail className="text-amber-500 shrink-0 mt-0.5" />
        <span>
          Turn on Email Backup here to pull attachments straight into your storage, or Google Backup
          if you&rsquo;ve linked a Google account — both run automatically once set up.
        </span>
      </p>
    ),
  },
  {
    target: 'sidebar-new-collection',
    route: '/client',
    needsSidebar: true,
    title: 'Media collections',
    body: (
      <p className="m-0 flex items-start gap-2">
        <MdPhotoLibrary className="text-amber-500 shrink-0 mt-0.5" />
        <span>
          Create a collection here to group your photos and videos together — the source folder for
          slideshow-style browsing, and for the AI recognition feature covered next.
        </span>
      </p>
    ),
  },
  {
    target: 'nav-files',
    title: 'AI-powered recognition',
    body: (
      <p className="m-0 flex items-start gap-2">
        <MdPhotoLibrary className="text-amber-500 shrink-0 mt-0.5" />
        <span>
          Premium accounts can turn on automatic people, pet, and object recognition for any media
          collection — files get grouped so you can browse by who or what is in them.{' '}
          <span className="font-medium">It&rsquo;s opt-in per collection, off by default</span> —
          turn it on from that collection&rsquo;s info panel whenever you&rsquo;re ready.
        </span>
      </p>
    ),
  },
  {
    target: 'api-keys-list',
    route: '/settings/api-keys',
    title: 'API keys for programmatic access',
    body: (
      <p className="m-0 flex items-start gap-2">
        <MdKey className="text-amber-500 shrink-0 mt-0.5" />
        <span>
          Issue scoped API keys here to read, write, list, or delete files through the SFS API —
          perfect for scripts, backup tools, or your own integrations.
        </span>
      </p>
    ),
  },
  {
    target: 'file-server-links',
    route: '/client/profile',
    title: 'Mount your storage as a drive',
    body: (
      <p className="m-0 flex items-start gap-2">
        <MdLink className="text-amber-500 shrink-0 mt-0.5" />
        <span>
          File server links let you mount your storage as a network drive on your computer, so you
          can work with files directly from the Finder, Explorer, or terminal.
        </span>
      </p>
    ),
  },
  {
    target: 'backup-reminder',
    route: '/client/profile',
    title: 'Backup reminders',
    body: (
      <>
        <p className="m-0 mb-2 flex items-start gap-2">
          <MdSync className="text-amber-500 shrink-0 mt-0.5" />
          <span>Turn on backup reminders here to get a nudge if your linked email backup hasn&rsquo;t synced in a while.</span>
        </p>
        <p className="m-0 flex items-center gap-2">
          <MdBolt className="text-amber-500 shrink-0" />
          You also get priority access to the fastest storage tier for your hottest files.
        </p>
      </>
    ),
  },
  {
    target: 'guides-card',
    route: '/client/profile',
    title: 'Enjoy Premium',
    body: (
      <p className="m-0 flex items-start gap-2">
        <MdStar className="text-amber-500 shrink-0 mt-0.5" />
        <span>
          That&rsquo;s everything Premium unlocks. Manage or cancel your subscription anytime from
          this page, and replay this guide from the Guides section whenever you like.
        </span>
      </p>
    ),
  },
]
