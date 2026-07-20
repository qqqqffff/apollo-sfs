import { useQuery } from '@tanstack/react-query'
import { getBillingConfig } from '../api/billing'

// Shared by every surface that needs PayPal config (premium card/modal,
// storage upgrade modal, register page): a single query cache entry means a
// single place to invalidate when it goes stale (e.g. the admin
// sandbox-payments toggle flips) instead of three drifting copies.
export function useBillingConfig() {
  return useQuery({
    queryKey: ['billing', 'config'],
    queryFn: getBillingConfig,
    staleTime: 60 * 60 * 1000,
  })
}
