import api from './client';
import type { StorageType } from './billing';

export interface PublicPremiumPlanOption {
  plan: 'monthly' | 'annual';
  price_cents: number;
}

export interface PublicConfig {
  turnstile_site_key: string;
  paypal_client_id?: string;
  paypal_currency?: string;
  paypal_environment?: string;
  premium_plans?: PublicPremiumPlanOption[];
}

export async function getPublicConfig(): Promise<PublicConfig> {
  const res = await api.get<PublicConfig>('/api/v1/config');
  return res.data;
}

export interface SubmitMobileInterestPayload {
  name: string;
  email: string;
  plan_id: string;
  storage_type: StorageType;
  use_case: string;
  deposit_order_id: string;
}

// Backend: POST /api/v1/mobile/interest — the native account request form.
// Same flow as the web /interest page minus the Cloudflare Turnstile widget.
export async function submitMobileInterestForm(payload: SubmitMobileInterestPayload): Promise<void> {
  await api.post('/api/v1/mobile/interest', payload);
}

export interface CreateInterestDepositResponse {
  order_id: string;
  approve_url: string;
}

export async function createInterestDepositOrder(
  planId: string,
  storageType: StorageType,
  paymentMethod: 'paypal' | 'card' = 'paypal',
): Promise<CreateInterestDepositResponse> {
  const res = await api.post<CreateInterestDepositResponse>('/api/v1/interest/deposit/orders', {
    plan_id: planId,
    storage_type: storageType,
    payment_method: paymentMethod,
  });
  return res.data;
}

export async function captureInterestDepositOrder(orderId: string): Promise<void> {
  await api.post(`/api/v1/interest/deposit/orders/${orderId}/capture`);
}
