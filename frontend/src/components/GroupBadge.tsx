// GroupBadge is the single source of truth for account-group ("admin",
// "premium", "user") badge styling. Every surface that labels an account's
// group — nav bar, profile, admin users table, files header — renders this
// component so the colors and shape stay consistent app-wide.

export type AccountGroup = 'admin' | 'premium' | 'user'

export function groupOf(u: { is_admin?: boolean; is_premium?: boolean } | null | undefined): AccountGroup {
  if (u?.is_admin) return 'admin'
  if (u?.is_premium) return 'premium'
  return 'user'
}

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
