import api from './client';

export type PremiumPlan = 'monthly' | 'annual';

export interface CreateSubscriptionResponse {
  subscription_id: string;
  approve_url: string;
}

// createPremiumSubscription starts a recurring PayPal subscription for the
// given plan. The mobile flow opens approve_url in the system browser, then
// calls confirmPremiumSubscription when the user returns (the
// BILLING.SUBSCRIPTION.ACTIVATED webhook is the durable fallback).
export async function createPremiumSubscription(plan: PremiumPlan): Promise<CreateSubscriptionResponse> {
  const res = await api.post<CreateSubscriptionResponse>('/api/v1/payments/subscriptions', { plan });
  return res.data;
}

export async function confirmPremiumSubscription(subscriptionId: string): Promise<void> {
  await api.post(`/api/v1/payments/subscriptions/${subscriptionId}/confirm`);
}

// cancelPremiumSubscription cancels the caller's own active subscription and
// immediately revokes premium (API keys, file-server links) — no grace period.
export async function cancelPremiumSubscription(): Promise<void> {
  await api.post('/api/v1/payments/subscriptions/cancel');
}

export type PremiumSubscriptionStatus =
  | 'approval_pending' | 'active' | 'suspended' | 'cancelled' | 'expired';

export interface PremiumSubscriptionOrder {
  id: string;
  plan: PremiumPlan;
  status: PremiumSubscriptionStatus;
  environment: 'sandbox' | 'live';
  amount_cents: number;
  currency: string;
  payment_method: string;
  reference: string;
  current_period_end: string | null;
  cancelled_at: string | null;
  created_at: string;
}

export async function listMySubscriptions(): Promise<PremiumSubscriptionOrder[]> {
  const res = await api.get<{ items: PremiumSubscriptionOrder[] }>('/api/v1/payments/subscriptions');
  return res.data.items ?? [];
}
