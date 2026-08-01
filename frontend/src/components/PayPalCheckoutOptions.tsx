import { PayPalScriptProvider } from '@paypal/react-paypal-js'
import { MdArrowBack } from 'react-icons/md'
import { PayPalGooglePayButton } from './PayPalGooglePayButton'
import { PayPalApplePayButton } from './PayPalApplePayButton'
import { PayPalWalletRedirectButton } from './PayPalWalletRedirectButton'
import type { RecurringTerms } from './recurringTerms'

// The funding sources this component's in-page buttons can produce an order
// with. The "PayPal" wallet button is not one of them — it redirects to a
// PayPal-hosted approval page rather than creating and confirming an order
// in-page (see PayPalWalletRedirectButton).
export type CheckoutSource = 'apple_pay' | 'google_pay' | 'card'

interface Props {
  clientId: string
  currency: string
  environment: 'sandbox' | 'live'
  // Resolves a browser-safe client token for the Apple Pay button's PayPal
  // Web SDK v6 instance (getPayPalClientToken on protected surfaces,
  // getPublicPayPalClientToken on the public interest page). Must come from
  // the same environment as `environment`.
  getClientToken: () => Promise<string>
  // Creates the order server-side and resolves to its PayPal order id — shared
  // by the Apple Pay button, the Google Pay button, and (once "Pay with card"
  // is chosen) HostedCardFields. The funding source is passed through because
  // some flows have to create a different order per source: a vaulting order's
  // payment_source key must match the source that will confirm it (see the
  // premium subscription modal). Callers that don't care can ignore it.
  createOrder: (source: CheckoutSource) => Promise<string>
  // Creates an order the same way and resolves to its PayPal-hosted approval
  // URL, for the "PayPal" wallet button below — see PayPalWalletRedirectButton
  // for why that one redirects instead of using createOrder+onApprove.
  getApprovalUrl: () => Promise<string>
  onApprove: (orderId: string, source: CheckoutSource) => Promise<void> | void
  onError: (message: string) => void
  // Current amount in major units (e.g. "30.00"), read at click time for the
  // Apple Pay / Google Pay sheets.
  amount: () => string
  canPay: boolean
  onChooseCard: () => void
  // Apple Pay is a live-only funding source — PayPal's sandbox doesn't
  // support it end to end. Defaults to true; callers that can be reached in
  // a sandbox-payments context (e.g. the admin's sandbox pass through the
  // account-request form) pass false to keep from accidentally taking a real
  // Apple Pay charge.
  showApplePay?: boolean
  // When set, the Apple Pay and Google Pay sheets authorise a recurring
  // charge and disclose the billing terms, instead of presenting a one-off
  // purchase. Required whenever the payment method will be billed again later
  // — see recurringTerms.ts. The PayPal wallet button and the card fields are
  // unaffected (PayPal discloses its own terms on the approval page; the card
  // form carries the disclosure in its own copy).
  recurring?: RecurringTerms
  // Whether Google Pay is usable for subscriptions at all; only consulted
  // when `recurring` is set. Off by default because PayPal doesn't vault the
  // google_pay payment source, so the subscription could never renew — see
  // docs/paypal_setup.md §10. Without it the Google Pay button hides on
  // subscription surfaces (it still works for one-time purchases).
  googlePaySubscriptionsEnabled?: boolean
}

// The wallet-checkout step shared by every payment surface (storage/premium
// upgrade modals, registration, and the account-request form): Apple Pay +
// Google Pay + the inline PayPal wallet button, plus a "Pay with card" button
// that hands off to HostedCardFields. Kept as one component so all four stay
// pixel- and behavior-identical instead of drifting copy to copy.
export function PayPalCheckoutOptions({
  clientId, currency, environment, getClientToken, createOrder, getApprovalUrl, onApprove, onError, amount, canPay, onChooseCard, showApplePay = true,
  recurring, googlePaySubscriptionsEnabled,
}: Props) {
  return (
    <div className={`flex flex-col gap-2 ${canPay ? '' : 'opacity-50 pointer-events-none'}`}>
      {/* Apple Pay runs on the PayPal Web SDK v6 (client-token init, loaded
          by the button itself) — deliberately outside the legacy
          PayPalScriptProvider below, which only the Google Pay button still
          needs. The v6 core coexists with the legacy SDK by attaching as
          window.paypal.v6. */}
      {showApplePay && (
        <PayPalApplePayButton
          environment={environment}
          currencyCode={currency}
          amount={amount}
          getClientToken={getClientToken}
          createOrder={() => createOrder('apple_pay')}
          onApprove={(orderId) => onApprove(orderId, 'apple_pay')}
          onError={onError}
          enabled={canPay}
          recurring={recurring}
        />
      )}
      <PayPalScriptProvider
        options={{
          clientId,
          currency,
          intent: 'capture',
          components: 'googlepay',
          // 'card' is disabled here because that funding source sends the
          // shopper to PayPal's hosted guest-checkout page (extra "ship to
          // billing address" / age-confirm copy we don't want) — "Pay with
          // card" below uses HostedCardFields instead, which stays in-page.
          disableFunding: 'paylater,card',
        }}
      >
        <PayPalGooglePayButton
          environment={environment}
          currencyCode={currency}
          amount={amount}
          createOrder={() => createOrder('google_pay')}
          onApprove={(orderId) => onApprove(orderId, 'google_pay')}
          onError={onError}
          enabled={canPay}
          recurring={recurring}
          subscriptionsEnabled={googlePaySubscriptionsEnabled}
        />
      </PayPalScriptProvider>
      <PayPalWalletRedirectButton
        disabled={!canPay}
        getApprovalUrl={getApprovalUrl}
        onError={onError}
      />
      <button
        type="button"
        onClick={onChooseCard}
        disabled={!canPay}
        className="w-full px-4 py-2.5 text-sm border border-gray-300 text-gray-700 rounded-lg font-medium hover:bg-gray-50 disabled:opacity-50 cursor-pointer transition-colors"
      >
        Pay with card
      </button>
      <p className="text-[11px] text-gray-400 text-center m-0">
        Payments are processed securely by PayPal.
      </p>
    </div>
  )
}

// The "‹ Back" link shown above the card-entry step (HostedCardFields) in
// every payment surface, to return to the wallet-checkout step above.
export function CheckoutBackButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 cursor-pointer bg-transparent border-0 p-0 transition-colors disabled:opacity-40"
    >
      <MdArrowBack className="text-base" /> Back
    </button>
  )
}
