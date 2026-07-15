import { PayPalScriptProvider } from '@paypal/react-paypal-js'
import { MdArrowBack } from 'react-icons/md'
import { PayPalGooglePayButton } from './PayPalGooglePayButton'
import { PayPalApplePayButton } from './PayPalApplePayButton'
import { PayPalWalletRedirectButton } from './PayPalWalletRedirectButton'

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
  // is chosen) HostedCardFields.
  createOrder: () => Promise<string>
  // Creates an order the same way and resolves to its PayPal-hosted approval
  // URL, for the "PayPal" wallet button below — see PayPalWalletRedirectButton
  // for why that one redirects instead of using createOrder+onApprove.
  getApprovalUrl: () => Promise<string>
  onApprove: (orderId: string) => Promise<void> | void
  onError: (message: string) => void
  // Current amount in major units (e.g. "30.00"), read at click time for the
  // Apple Pay / Google Pay sheets.
  amount: () => string
  canPay: boolean
  onChooseCard: () => void
}

// The wallet-checkout step shared by every payment surface (storage/premium
// upgrade modals, registration, and the account-request form): Apple Pay +
// Google Pay + the inline PayPal wallet button, plus a "Pay with card" button
// that hands off to HostedCardFields. Kept as one component so all four stay
// pixel- and behavior-identical instead of drifting copy to copy.
export function PayPalCheckoutOptions({
  clientId, currency, environment, getClientToken, createOrder, getApprovalUrl, onApprove, onError, amount, canPay, onChooseCard,
}: Props) {
  return (
    <div className={`flex flex-col gap-2 ${canPay ? '' : 'opacity-50 pointer-events-none'}`}>
      {/* Apple Pay runs on the PayPal Web SDK v6 (client-token init, loaded
          by the button itself) — deliberately outside the legacy
          PayPalScriptProvider below, which only the Google Pay button still
          needs. The v6 core coexists with the legacy SDK by attaching as
          window.paypal.v6. */}
      <PayPalApplePayButton
        environment={environment}
        currencyCode={currency}
        amount={amount}
        getClientToken={getClientToken}
        createOrder={createOrder}
        onApprove={onApprove}
        onError={onError}
        enabled={canPay}
      />
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
          createOrder={createOrder}
          onApprove={onApprove}
          onError={onError}
          enabled={canPay}
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
