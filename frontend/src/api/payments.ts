import { post } from './client'

export type PaymentMethod = 'apple_pay' | 'card'

export interface CreateOrderResponse {
  order_id: string
  approve_url: string
}

export interface CaptureOrderResponse {
  order_id: string
  capture_id: string
  status: string
}

export function createPaymentOrder(method: PaymentMethod): Promise<CreateOrderResponse> {
  return post<CreateOrderResponse>('/payments/orders', { payment_method: method })
}

// createPremiumWalletOrder creates a PayPal order with no funding source
// locked in, so it works with the PayPal wallet button, Google Pay, and
// hosted card fields — the same generic order used by the storage-allocation
// modal. Capture goes through the same capturePaymentOrder below.
export function createPremiumWalletOrder(): Promise<CreateOrderResponse> {
  return post<CreateOrderResponse>('/payments/orders/wallet')
}

export function capturePaymentOrder(orderID: string): Promise<CaptureOrderResponse> {
  return post<CaptureOrderResponse>(`/payments/orders/${orderID}/capture`)
}
