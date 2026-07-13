import api from './client';

export type StorageType = 'nvme' | 'hdd';

export interface StorageOrderResult {
  order_id: string;
  approval_url: string;
}

export interface StorageCaptureResult {
  new_quota_bytes: number;
}

// Backend: POST /api/v1/billing/storage/order
// Creates a PayPal order for a storage add-on and returns the PayPal approval URL.
export async function createStorageOrder(
  planId: string,
  storageType: StorageType,
): Promise<StorageOrderResult> {
  const res = await api.post<StorageOrderResult>('/api/v1/billing/storage/order', {
    plan_id: planId,
    storage_type: storageType,
  });
  return res.data;
}

// Backend: POST /api/v1/billing/storage/order/:orderId/capture
// Captures an approved PayPal order and applies the storage to the account.
export async function captureStorageOrder(orderId: string): Promise<StorageCaptureResult> {
  const res = await api.post<StorageCaptureResult>(
    `/api/v1/billing/storage/order/${orderId}/capture`,
  );
  return res.data;
}

// Backend: POST /api/v1/billing/storage/hosted-card
// Captures a PayPal order created client-side via hosted fields JS SDK.
export async function captureHostedCardStorageOrder(
  orderId: string,
  planId: string,
  storageType: StorageType,
): Promise<StorageCaptureResult> {
  const res = await api.post<StorageCaptureResult>('/api/v1/billing/storage/hosted-card', {
    order_id: orderId,
    plan_id: planId,
    storage_type: storageType,
  });
  return res.data;
}

export interface CardPaymentData {
  number: string;
  expiry_month: string;
  expiry_year: string;
  cvv: string;
  name: string;
}

// Backend: POST /api/v1/billing/storage/card
// Processes a card payment via PayPal Advanced Credit and Debit Card Payments.
export async function createCardStorageOrder(
  planId: string,
  storageType: StorageType,
  card: CardPaymentData,
): Promise<StorageCaptureResult> {
  const res = await api.post<StorageCaptureResult>('/api/v1/billing/storage/card', {
    plan_id: planId,
    storage_type: storageType,
    card,
  });
  return res.data;
}

// Backend: POST /api/v1/billing/storage/apple-pay
// Processes an Apple Pay token via PayPal.
export async function createApplePayStorageOrder(
  planId: string,
  storageType: StorageType,
  applePayToken: object,
): Promise<StorageCaptureResult> {
  const res = await api.post<StorageCaptureResult>('/api/v1/billing/storage/apple-pay', {
    plan_id: planId,
    storage_type: storageType,
    apple_pay_token: applePayToken,
  });
  return res.data;
}

// Backend: POST /api/v1/billing/storage/google-pay
// Processes a Google Pay token via PayPal.
export async function createGooglePayStorageOrder(
  planId: string,
  storageType: StorageType,
  googlePayToken: string,
): Promise<StorageCaptureResult> {
  const res = await api.post<StorageCaptureResult>('/api/v1/billing/storage/google-pay', {
    plan_id: planId,
    storage_type: storageType,
    google_pay_token: googlePayToken,
  });
  return res.data;
}

// ── Expansion deposit endpoints ────────────────────────────────────────────────

export interface ExpansionOrderResult {
  order_id: string;
  approval_url: string;
  deposit_cents: number;
  full_price_cents: number;
}

export interface ExpansionRequestResult {
  expansion_request_id: string;
  expires_at: string;
}

export async function createExpansionOrder(
  planId: string,
  storageType: StorageType,
  serverId: string,
): Promise<ExpansionOrderResult> {
  const res = await api.post<ExpansionOrderResult>('/api/v1/billing/storage/expansion/order', {
    plan_id: planId,
    storage_type: storageType,
    server_id: serverId,
  });
  return res.data;
}

export async function captureExpansionOrder(orderId: string): Promise<ExpansionRequestResult> {
  const res = await api.post<ExpansionRequestResult>(
    `/api/v1/billing/storage/expansion/order/${orderId}/capture`,
  );
  return res.data;
}

// Backend: POST /api/v1/billing/storage/expansion/hosted-card
// Captures an expansion deposit order created client-side via hosted fields JS SDK.
export async function captureHostedCardExpansionOrder(
  orderId: string,
  planId: string,
  storageType: StorageType,
  serverId: string,
): Promise<ExpansionRequestResult> {
  const res = await api.post<ExpansionRequestResult>('/api/v1/billing/storage/expansion/hosted-card', {
    order_id: orderId,
    plan_id: planId,
    storage_type: storageType,
    server_id: serverId,
  });
  return res.data;
}

export async function createCardExpansionOrder(
  planId: string,
  storageType: StorageType,
  serverId: string,
  card: CardPaymentData,
): Promise<ExpansionRequestResult> {
  const res = await api.post<ExpansionRequestResult>('/api/v1/billing/storage/expansion/card', {
    plan_id: planId,
    storage_type: storageType,
    server_id: serverId,
    card,
  });
  return res.data;
}

export async function createApplePayExpansionOrder(
  planId: string,
  storageType: StorageType,
  serverId: string,
  applePayToken: object,
): Promise<ExpansionRequestResult> {
  const res = await api.post<ExpansionRequestResult>('/api/v1/billing/storage/expansion/apple-pay', {
    plan_id: planId,
    storage_type: storageType,
    server_id: serverId,
    apple_pay_token: applePayToken,
  });
  return res.data;
}

export async function createGooglePayExpansionOrder(
  planId: string,
  storageType: StorageType,
  serverId: string,
  googlePayToken: string,
): Promise<ExpansionRequestResult> {
  const res = await api.post<ExpansionRequestResult>('/api/v1/billing/storage/expansion/google-pay', {
    plan_id: planId,
    storage_type: storageType,
    server_id: serverId,
    google_pay_token: googlePayToken,
  });
  return res.data;
}

// ── Pay-remaining endpoints (called after admin marks request as expanded) ─────

export interface PayRemainingOrderResult {
  order_id: string;
  approval_url: string;
  remaining_cents: number;
}

export interface PayRemainingResult {
  new_quota_bytes: number;
}

export async function createPayRemainingWalletOrder(requestId: string): Promise<PayRemainingOrderResult> {
  const res = await api.post<PayRemainingOrderResult>(
    `/api/v1/billing/storage/expansion/${requestId}/pay-remaining/order`,
  );
  return res.data;
}

export async function capturePayRemainingWalletOrder(
  requestId: string,
  orderId: string,
): Promise<PayRemainingResult> {
  const res = await api.post<PayRemainingResult>(
    `/api/v1/billing/storage/expansion/${requestId}/pay-remaining/order/${orderId}/capture`,
  );
  return res.data;
}

export async function payRemainingByCard(
  requestId: string,
  card: CardPaymentData,
): Promise<PayRemainingResult> {
  const res = await api.post<PayRemainingResult>(
    `/api/v1/billing/storage/expansion/${requestId}/pay-remaining/card`,
    { card },
  );
  return res.data;
}

export async function payRemainingByApplePay(
  requestId: string,
  applePayToken: object,
): Promise<PayRemainingResult> {
  const res = await api.post<PayRemainingResult>(
    `/api/v1/billing/storage/expansion/${requestId}/pay-remaining/apple-pay`,
    { apple_pay_token: applePayToken },
  );
  return res.data;
}

export async function payRemainingByGooglePay(
  requestId: string,
  googlePayToken: string,
): Promise<PayRemainingResult> {
  const res = await api.post<PayRemainingResult>(
    `/api/v1/billing/storage/expansion/${requestId}/pay-remaining/google-pay`,
    { google_pay_token: googlePayToken },
  );
  return res.data;
}

// ── Shared helpers / config ─────────────────────────────────────────────────

export function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export interface PremiumPlanOption {
  plan: 'monthly' | 'annual';
  price_cents: number;
}

export interface BillingConfig {
  paypal_client_id: string;
  currency: string;
  // 'sandbox' when the admin's session sandbox-payments toggle is on.
  environment: 'sandbox' | 'live';
  premium_plans: PremiumPlanOption[];
}

// Backend: GET /api/v1/billing/config — per-session PayPal config (reflects
// the admin sandbox-payments toggle).
export async function getBillingConfig(): Promise<BillingConfig> {
  const res = await api.get<BillingConfig>('/api/v1/billing/config');
  return res.data;
}

// ── User's expansion request history ────────────────────────────────────────

export type ExpansionStatus =
  | 'opened' | 'invoice_sent' | 'accepted' | 'approved' | 'expanded'
  | 'completed' | 'expired' | 'refunded' | 'rejected';

export interface ExpansionRequest {
  id: string;
  username: string;
  server_id: string;
  server_name: string;
  plan_id: string;
  storage_type: StorageType;
  bytes_requested: number;
  deposit_amount_cents: number;
  full_price_cents: number;
  currency: string;
  payment_method: string;
  status: ExpansionStatus;
  is_custom: boolean;
  expires_at: string;
  approval_due_at: string | null;
  approved_at: string | null;
  expansion_due_at: string | null;
  payment_due_at: string | null;
  reminder_sent_at: string | null;
  created_at: string;
  completed_at: string | null;
  cancellation_reason: string | null;
  paypal_capture_id: string | null;
  // Latest invoice summary (custom requests only).
  invoice_number?: string;
  invoice_status?: string;
  invoice_sent_at?: string;
  invoice_accept_due_at?: string;
  invoice_review_token?: string;
}

export async function listMyExpansionRequests(): Promise<ExpansionRequest[]> {
  const res = await api.get<{ items: ExpansionRequest[] }>('/api/v1/billing/storage/expansion/requests');
  return res.data.items ?? [];
}

// ── User's combined order history (premium + storage purchases) ─────────────

export interface UserOrder {
  id: string;
  type: 'premium' | 'storage';
  status: string;
  amount_cents: number;
  currency: string;
  payment_method: string;
  reference: string;
  invoice_number: string;
  created_at: string;
  captured_at: string | null;
  refunded_at: string | null;
  // Set once the order's local quota/premium grant has been undone via the
  // admin "Revert allocation" action or the 7-day sandbox auto-revert loop.
  allocation_reverted_at: string | null;
  plan_id?: string;
  storage_type?: string;
  bytes_added?: number;
  server_name?: string;
  // 'sandbox' means it came from an admin's sandbox-payments toggle.
  environment: 'sandbox' | 'live';
}

export async function listMyOrders(): Promise<UserOrder[]> {
  const res = await api.get<{ items: UserOrder[] }>('/api/v1/billing/orders');
  return res.data.items ?? [];
}
