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
