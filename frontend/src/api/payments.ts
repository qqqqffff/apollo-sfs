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

// SelfBilledSource is a funding source PayPal Subscriptions v1 can't be bound
// to. POST /v1/billing/subscriptions ignores `payment_source` entirely, so a
// card or wallet cannot approve a PayPal-managed subscription — those open a
// subscription the API bills itself instead: the first period is an ordinary
// Orders v2 purchase that also vaults the payment method, and the API's
// renewal loop charges that saved method every period after.
//
// The two calls below are the usual create-order / confirm-order pair every
// web payment surface uses (Apple Pay sheet, Google Pay sheet, hosted card
// fields), so no card data ever reaches our servers.
export type SelfBilledSource = 'card' | 'apple_pay' | 'google_pay'

export interface SelfBilledOrderResponse {
  order_id: string
  amount_cents: number
  currency: string
}

export function createSelfBilledSubscriptionOrder(
  plan: PremiumPlan,
  source: SelfBilledSource,
): Promise<SelfBilledOrderResponse> {
  return post<SelfBilledOrderResponse>('/payments/subscriptions/wallet/order', { plan, source })
}

export interface ConfirmSelfBilledResponse {
  status: string
  subscription_id: string
  current_period_end: string
}

// confirmSelfBilledSubscription captures the first period and opens the
// subscription. If PayPal returned no vault id the charge is refunded server-
// side and this rejects — a subscription that can't renew is never granted.
export function confirmSelfBilledSubscription(
  orderId: string,
  plan: PremiumPlan,
  source: SelfBilledSource,
): Promise<ConfirmSelfBilledResponse> {
  return post<ConfirmSelfBilledResponse>('/payments/subscriptions/wallet/confirm', {
    order_id: orderId,
    plan,
    source,
  })
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
