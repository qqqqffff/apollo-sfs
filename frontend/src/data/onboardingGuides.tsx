import type { ReactNode } from 'react'
import { MdBolt, MdCloudUpload, MdFolderShared, MdKey, MdLink, MdPhotoLibrary, MdStar, MdSync } from 'react-icons/md'
import { GroupBadge } from '../components/GroupBadge'

export interface GuideStep {
  title: string
  body: ReactNode
}

// BASE_GUIDE_STEPS walks every account through the features available on
// the free tier. Shown once per account (see OnboardingGuideContext) and
// replayable anytime from the Profile page.
export const BASE_GUIDE_STEPS: GuideStep[] = [
  {
    title: 'Welcome to Apollo SFS',
    body: (
      <>
        <p className="m-0 mb-3">
          Apollo SFS is your own encrypted file storage — upload, organize, and share files, all
          protected end-to-end. This quick tour covers the essentials of a free account.
        </p>
        <p className="m-0">
          Use <span className="font-medium">Next</span> and <span className="font-medium">Back</span> to
          move at your own pace, or click <span className="font-medium">Skip guide</span> anytime. You
          can replay this tour later from your Profile page.
        </p>
      </>
    ),
  },
  {
    title: 'Upload and organize',
    body: (
      <>
        <p className="m-0 mb-3 flex items-start gap-2">
          <MdCloudUpload className="text-blue-500 shrink-0 mt-0.5" />
          Drag and drop files anywhere on the Files page, or use the upload button, to add them to
          your storage. Files are encrypted before they ever leave your device.
        </p>
        <p className="m-0">
          Create folders to keep things organized, and move or rename files and folders anytime from
          the file browser.
        </p>
      </>
    ),
  },
  {
    title: 'Share and collaborate',
    body: (
      <>
        <p className="m-0 mb-3 flex items-start gap-2">
          <MdFolderShared className="text-blue-500 shrink-0 mt-0.5" />
          Generate a share link for any file or folder right from the file browser — pick who can
          view it and for how long, without giving up access to your account.
        </p>
        <p className="m-0">
          Favorites and shared items both live in the side panel on the Files page for quick access.
        </p>
      </>
    ),
  },
  {
    title: 'Storage usage and tiers',
    body: (
      <>
        <p className="m-0 mb-3">
          Your Profile page shows exactly how much of your quota you&rsquo;ve used, with a one-click
          way to add more storage whenever you need it.
        </p>
        <p className="m-0">
          Apollo SFS spreads storage across a fast tier and a standard tier — pick the right one for
          hot, frequently-used files versus cold archives.
        </p>
      </>
    ),
  },
  {
    title: 'Your profile and account',
    body: (
      <>
        <p className="m-0 mb-3">
          The Profile page is home base for your account: linked sign-in providers, order history,
          password changes, and the preferences that control how storage prompts show up.
        </p>
        <p className="m-0">
          Want more — API access, AI-powered photo search, WebDAV mounts? Check out{' '}
          <GroupBadge group="premium" className="align-middle" /> from the same page anytime.
        </p>
      </>
    ),
  },
  {
    title: "That's the tour",
    body: (
      <>
        <p className="m-0 mb-3">
          You&rsquo;re ready to go. If you ever want a refresher, replay this guide from the{' '}
          <span className="font-medium">Guides</span> section of your Profile page.
        </p>
        <p className="m-0">Click Finish to start using Apollo SFS.</p>
      </>
    ),
  },
]

// PREMIUM_GUIDE_STEPS is shown once to every premium account — either the
// first time it's shown to an existing subscriber, or immediately after a
// user's first premium purchase (see OnboardingGuideContext) — and is
// replayable anytime from the Profile page.
export const PREMIUM_GUIDE_STEPS: GuideStep[] = [
  {
    title: "You're on Premium",
    body: (
      <>
        <p className="m-0 mb-3 flex items-center gap-2">
          <GroupBadge group="premium" />
          <span>Your account now carries the Premium badge — you&rsquo;ll see it next to your
          username in the nav bar and on your Profile page.</span>
        </p>
        <p className="m-0">
          This short tour highlights what Premium unlocks. Skip it anytime, or replay it later from
          your Profile page.
        </p>
      </>
    ),
  },
  {
    title: 'AI-powered recognition',
    body: (
      <>
        <p className="m-0 mb-3 flex items-start gap-2">
          <MdPhotoLibrary className="text-amber-500 shrink-0 mt-0.5" />
          Premium accounts get automatic people, pet, and object recognition across their photo and
          video library — files are grouped so you can browse by who or what is in them.
        </p>
        <p className="m-0">
          Recognition runs entirely on encrypted copies decrypted just-in-time for indexing — your
          keys and files stay private.
        </p>
      </>
    ),
  },
  {
    title: 'API keys for programmatic access',
    body: (
      <>
        <p className="m-0 mb-3 flex items-start gap-2">
          <MdKey className="text-amber-500 shrink-0 mt-0.5" />
          Issue scoped API keys from Settings → API Keys to read, write, list, or delete files
          through the SFS API — perfect for scripts, backup tools, or your own integrations.
        </p>
        <p className="m-0">Each key can be limited to a single folder and given its own expiry.</p>
      </>
    ),
  },
  {
    title: 'Mount your storage as a drive',
    body: (
      <>
        <p className="m-0 mb-3 flex items-start gap-2">
          <MdLink className="text-amber-500 shrink-0 mt-0.5" />
          File server links let you mount your Apollo SFS storage as a network drive on your
          computer, so you can work with your files directly from the Finder, Explorer, or terminal.
        </p>
        <p className="m-0">Manage your links anytime from the Profile page.</p>
      </>
    ),
  },
  {
    title: 'Backup reminders',
    body: (
      <>
        <p className="m-0 mb-3 flex items-start gap-2">
          <MdSync className="text-amber-500 shrink-0 mt-0.5" />
          Turn on backup reminders from your Profile page to get a nudge if your linked email backup
          hasn&rsquo;t synced in a while, so nothing slips through the cracks.
        </p>
        <p className="m-0 flex items-center gap-2">
          <MdBolt className="text-amber-500 shrink-0" />
          You also get priority access to the fastest storage tier for your hottest files.
        </p>
      </>
    ),
  },
  {
    title: 'Enjoy Premium',
    body: (
      <>
        <p className="m-0 mb-3 flex items-center gap-2">
          <MdStar className="text-amber-500 shrink-0" />
          That&rsquo;s everything Premium unlocks. Manage or cancel your subscription anytime from
          the Profile page.
        </p>
        <p className="m-0">
          You can replay this guide whenever you like from the{' '}
          <span className="font-medium">Guides</span> section of your Profile page.
        </p>
      </>
    ),
  },
]
