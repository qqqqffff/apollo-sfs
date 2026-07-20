// GroupBadge is the single source of truth for account-group ("admin",
// "premium", "user") badge styling. Every surface that labels an account's
// group — nav bar, profile, admin users table, files header — renders this
// component so the colors and shape stay consistent app-wide.

export type AccountGroup = 'admin' | 'premium' | 'user'

const THEME: Record<AccountGroup, { label: string; className: string }> = {
  admin:   { label: 'Admin',   className: 'bg-purple-100 text-purple-700' },
  premium: { label: 'Premium', className: 'bg-amber-100 text-amber-700' },
  user:    { label: 'User',    className: 'bg-gray-100 text-gray-500' },
}

interface Props {
  group: AccountGroup
  // Optional size/spacing overrides (e.g. the compact nav-bar chip); the
  // group colors themselves are fixed.
  className?: string
  title?: string
}

export function GroupBadge({ group, className = '', title }: Props) {
  const theme = THEME[group]
  return (
    <span
      title={title}
      className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full whitespace-nowrap ${theme.className} ${className}`}
    >
      {theme.label}
    </span>
  )
}

interface AccountBadgesUser {
  is_admin?: boolean
  is_premium?: boolean
  // Distinguishes an admin who actually subscribed to premium from one who
  // only has is_premium via the implicit admin-includes-premium rule (see
  // api/routes/middleware/auth.go). Absent/false is treated as "not
  // subscribed" — safe for callers that don't have the field yet.
  premium_subscribed?: boolean
}

interface AccountBadgesProps {
  user: AccountBadgesUser | null | undefined
  className?: string
}

// AccountBadges renders every badge that applies to an account: normally
// just one ("Admin", "Premium", or "User"), but both "Admin" and "Premium"
// together when an admin has an actual premium subscription of their own —
// so a subscribed admin's badge reflects that instead of being hidden behind
// the implicit admin-includes-premium rule.
export function AccountBadges({ user, className = '' }: AccountBadgesProps) {
  if (!user) return null
  const showAdmin = !!user.is_admin
  const showPremium = !!user.is_premium && (!user.is_admin || !!user.premium_subscribed)

  if (!showAdmin && !showPremium) {
    return <GroupBadge group="user" className={className} />
  }

  return (
    <span className="inline-flex items-center gap-1">
      {showAdmin && (
        <GroupBadge
          group="admin"
          className={className}
          title={showPremium ? undefined : 'Admin (premium included)'}
        />
      )}
      {showPremium && (
        <GroupBadge group="premium" className={className} title="Premium subscriber" />
      )}
    </span>
  )
}
