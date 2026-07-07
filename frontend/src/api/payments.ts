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

export function capturePaymentOrder(orderID: string): Promise<CaptureOrderResponse> {
  return post<CaptureOrderResponse>(`/payments/orders/${orderID}/capture`)
}

// Premium purchase via Google Pay: the token is created + captured server-side
// in one call (no separate approval step), then premium is granted.
export function chargePremiumGooglePay(googlePayToken: string): Promise<{ status: string }> {
  return post<{ status: string }>('/payments/orders/google-pay', { google_pay_token: googlePayToken })
}
