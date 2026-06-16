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
