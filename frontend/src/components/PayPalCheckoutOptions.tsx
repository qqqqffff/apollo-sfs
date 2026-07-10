import { PayPalScriptProvider, PayPalButtons } from '@paypal/react-paypal-js'
import { MdArrowBack } from 'react-icons/md'
import { PayPalGooglePayButton } from './PayPalGooglePayButton'

interface Props {
  clientId: string
  currency: string
  environment: 'sandbox' | 'live'
  // Creates the order server-side and resolves to its PayPal order id — shared
  // by the Google Pay button, the PayPal wallet button, and (once "Pay with
  // card" is chosen) HostedCardFields.
  createOrder: () => Promise<string>
  onApprove: (orderId: string) => Promise<void> | void
  onError: (message: string) => void
  onCancel?: () => void
  // Current amount in major units (e.g. "30.00"), read at click time for the
  // Google Pay sheet.
  amount: () => string
  canPay: boolean
  onChooseCard: () => void
}

// The wallet-checkout step shared by every payment surface (storage/premium
// upgrade modals, registration, and the account-request form): Google Pay +
// the inline PayPal wallet button, plus a "Pay with card" button that hands
// off to HostedCardFields. Kept as one component so all four stay pixel- and
// behavior-identical instead of drifting copy to copy.
export function PayPalCheckoutOptions({
  clientId, currency, environment, createOrder, onApprove, onError, onCancel, amount, canPay, onChooseCard,
}: Props) {
  return (
    <div className={canPay ? '' : 'opacity-50 pointer-events-none'}>
      <PayPalScriptProvider
        options={{
          clientId,
          currency,
          intent: 'capture',
          components: 'buttons,googlepay',
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
        <PayPalButtons
          disabled={!canPay}
          style={{ layout: 'vertical', shape: 'rect', label: 'pay' }}
          createOrder={createOrder}
          onApprove={async (data) => { await onApprove(data.orderID) }}
          onError={(err) => onError(err instanceof Error ? err.message : 'Payment failed')}
          onCancel={onCancel}
        />
      </PayPalScriptProvider>
      <button
        type="button"
        onClick={onChooseCard}
        disabled={!canPay}
        className="w-full mt-2 px-4 py-2.5 text-sm border border-gray-300 text-gray-700 rounded-lg font-medium hover:bg-gray-50 disabled:opacity-50 cursor-pointer transition-colors"
      >
        Pay with card
      </button>
      <p className="text-[11px] text-gray-400 text-center m-0 mt-2">
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
