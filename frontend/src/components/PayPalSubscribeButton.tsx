import { PayPalWalletRedirectButton } from './PayPalWalletRedirectButton'

interface Props {
  // Creates the subscription server-side and resolves to its PayPal-hosted
  // approval URL — see api/payments.ts createPremiumSubscription. The
  // frontend redirects the browser there directly rather than using
  // react-paypal-js's popup-based <PayPalButtons>; see
  // PayPalWalletRedirectButton for why. PayPal redirects back to the
  // return_url the backend configured (payments/handler.go's
  // CreateSubscription — .../premium?status=approved&subscription_id=...),
  // which _auth.premium.tsx already reads to confirm the grant.
  getApprovalUrl: () => Promise<string>
  onError: (message: string) => void
  disabled?: boolean
}

// The premium subscribe button: PayPal's hosted subscription approval flow
// (PayPal balance, linked bank/cards, Venmo).
export function PayPalSubscribeButton({ getApprovalUrl, onError, disabled }: Props) {
  return (
    <div className={disabled ? 'opacity-50 pointer-events-none' : ''}>
      <PayPalWalletRedirectButton disabled={disabled} getApprovalUrl={getApprovalUrl} onError={onError} />
      <p className="text-[11px] text-gray-400 text-center m-0 mt-2">
        Payments are processed securely by PayPal.
      </p>
    </div>
  )
}
