import { get, post } from './client'

export type PremiumPlan = 'monthly' | 'annual'

export interface CreateSubscriptionResponse {
  subscription_id: string
  approve_url: string
}

export interface ConfirmSubscriptionResponse {
  status: string
}

// createPremiumSubscription starts a recurring PayPal subscription for the
// given plan. The shopper approves it on PayPal's hosted page; call
// confirmPremiumSubscription with the returned subscription_id right after
// the approval redirect to apply the grant immediately (the
// BILLING.SUBSCRIPTION.ACTIVATED webhook is the durable source of truth and
// will also apply it if this call is missed).
export function createPremiumSubscription(plan: PremiumPlan): Promise<CreateSubscriptionResponse> {
  return post<CreateSubscriptionResponse>('/payments/subscriptions', { plan })
}

export function confirmPremiumSubscription(subscriptionId: string): Promise<ConfirmSubscriptionResponse> {
  return post<ConfirmSubscriptionResponse>(`/payments/subscriptions/${subscriptionId}/confirm`)
}

// cancelPremiumSubscription cancels the caller's own active subscription and
// immediately revokes premium (API keys, file-server links) — there is no
// "keep access until the paid-through date" grace period.
export function cancelPremiumSubscription(): Promise<{ status: string }> {
  return post<{ status: string }>('/payments/subscriptions/cancel')
}

export type PremiumSubscriptionStatus = 'approval_pending' | 'active' | 'suspended' | 'cancelled' | 'expired'

// PremiumSubscriptionOrder is one of the caller's premium subscriptions
// (including past cancelled/expired ones), shaped like billing.ts's
// UserOrder — amount_cents/currency/payment_method/reference/environment —
// plus current_period_end, which the orders page reads as both "premium
// until" and "next payment date" (identical while a subscription is active).
export interface PremiumSubscriptionOrder {
  id: string
  plan: PremiumPlan
  status: PremiumSubscriptionStatus
  environment: 'sandbox' | 'live'
  amount_cents: number
  currency: string
  payment_method: string
  reference: string
  current_period_end: string | null
  cancelled_at: string | null
  created_at: string
}

export async function listMySubscriptions(): Promise<PremiumSubscriptionOrder[]> {
  const res = await get<{ items: PremiumSubscriptionOrder[] }>('/payments/subscriptions')
  return res.items ?? []
}
