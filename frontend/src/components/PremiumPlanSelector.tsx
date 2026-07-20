import { formatCents } from '../api/billing'
import type { PremiumPlanOption } from '../api/billing'
import type { PremiumPlan } from '../api/payments'

interface Props {
  plans: PremiumPlanOption[]
  selected: PremiumPlan
  onSelect: (plan: PremiumPlan) => void
  disabled?: boolean
}

// Monthly/annual plan picker shared by every premium subscribe surface
// (upgrade modal, full-page checkout, register-page inline checkout) so the
// two prices and selection styling stay identical across all three.
export function PremiumPlanSelector({ plans, selected, onSelect, disabled }: Props) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {plans.map((p) => (
        <button
          key={p.plan}
          type="button"
          disabled={disabled}
          onClick={() => onSelect(p.plan)}
          className={`flex flex-col items-start gap-1 p-3 rounded-lg border-2 text-left cursor-pointer transition-colors disabled:opacity-50 ${
            selected === p.plan ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-gray-300'
          }`}
        >
          <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">
            {p.plan === 'monthly' ? 'Monthly' : 'Annual'}
          </span>
          <span className="text-sm font-semibold text-gray-900">
            {formatCents(p.price_cents)}{p.plan === 'monthly' ? '/mo' : '/yr'}
          </span>
        </button>
      ))}
    </div>
  )
}
