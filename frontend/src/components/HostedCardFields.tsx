import { useState } from 'react'
import {
  PayPalScriptProvider,
  PayPalCardFieldsProvider,
  PayPalCardFieldsForm,
  usePayPalCardFields,
} from '@paypal/react-paypal-js'
import { PayPalGooglePayButton } from './PayPalGooglePayButton'

interface Props {
  // Public PayPal client id (from GET /config or /billing/config).
  clientId: string
  currency: string
  // Creates the order server-side and resolves to its PayPal order id. The card
  // entered in the hosted fields is attached to THIS order on submit.
  createOrder: () => Promise<string>
  // Called with the order id after the shopper's card authorises the order.
  // Run the server-side capture here.
  onApprove: (orderId: string) => Promise<void> | void
  onError?: (message: string) => void
  submitLabel: string
  // Disables the pay button (e.g. while a plan hasn't been chosen or a capture
  // is in flight). The card fields themselves stay interactive.
  disabled?: boolean
  // When provided, a PayPal-orchestrated Google Pay button is shown above the
  // card fields (sharing this component's SDK provider). Returns the current
  // amount in major units for the Google Pay sheet. Google Pay reuses the same
  // createOrder/onApprove as the card fields.
  googlePayAmount?: () => string
  // PayPal environment — required for Google Pay to pick its TEST/PRODUCTION
  // environment. Defaults to 'live'. Only relevant when googlePayAmount is set.
  environment?: 'sandbox' | 'live'
}

// HostedCardFields renders PayPal's PCI-compliant hosted card fields — the card
// number, expiry, and CVV inputs are iframes served by PayPal, so raw card data
// never touches our frontend or backend (SAQ A eligibility). Loads the SDK with
// components="card-fields"; keep this the ONLY PayPalScriptProvider on its page
// (a second provider with different components can prevent the SDK resolving).
export function HostedCardFields({
  clientId, currency, createOrder, onApprove, onError, submitLabel, disabled, googlePayAmount,
  environment = 'live',
}: Props) {
  return (
    <PayPalScriptProvider
      options={{
        clientId,
        currency,
        intent: 'capture',
        components: googlePayAmount ? 'card-fields,googlepay' : 'card-fields',
      }}
    >
      {googlePayAmount && (
        <>
          <PayPalGooglePayButton
            environment={environment}
            currencyCode={currency}
            amount={googlePayAmount}
            createOrder={createOrder}
            onApprove={onApprove}
            onError={onError}
            enabled={!disabled}
          />
          <div className="flex items-center gap-2 my-3 text-[11px] text-gray-400">
            <span className="flex-1 h-px bg-gray-200" />or pay by card<span className="flex-1 h-px bg-gray-200" />
          </div>
        </>
      )}
      <PayPalCardFieldsProvider
        createOrder={createOrder}
        onApprove={(data) => onApprove(data.orderID)}
        onError={(err) => onError?.(err instanceof Error ? err.message : 'Card payment failed')}
      >
        <PayPalCardFieldsForm />
        <SubmitButton submitLabel={submitLabel} disabled={disabled} onError={onError} />
      </PayPalCardFieldsProvider>
    </PayPalScriptProvider>
  )
}

function SubmitButton({
  submitLabel, disabled, onError,
}: { submitLabel: string; disabled?: boolean; onError?: (message: string) => void }) {
  const { cardFieldsForm } = usePayPalCardFields()
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit() {
    if (!cardFieldsForm) {
      onError?.('Card fields are still loading — please try again.')
      return
    }
    setSubmitting(true)
    try {
      // Rejects if the card is invalid/incomplete or the order is declined;
      // otherwise resolves and the provider's onApprove fires with the order id.
      await cardFieldsForm.submit()
    } catch (err) {
      onError?.(err instanceof Error ? err.message : 'Card payment failed — check your details and try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <button
      type="button"
      onClick={handleSubmit}
      disabled={disabled || submitting}
      className="w-full mt-3 px-4 py-3 text-sm font-semibold bg-blue-600 hover:bg-blue-700 text-white rounded-xl disabled:opacity-50 transition-colors cursor-pointer"
    >
      {submitting ? 'Processing…' : submitLabel}
    </button>
  )
}
