import { PayPalScriptProvider, PayPalButtons } from '@paypal/react-paypal-js'

interface Props {
  clientId: string
  // Creates the subscription server-side and resolves to its PayPal
  // subscription id — see api/payments.ts createPremiumSubscription.
  createSubscription: () => Promise<string>
  onApprove: (subscriptionId: string) => Promise<void> | void
  onError: (message: string) => void
  onCancel?: () => void
  disabled?: boolean
}

// The premium subscribe button: PayPal's hosted subscription approval flow
// (PayPal balance, linked bank/cards, Venmo). Deliberately its own component
// rather than another mode on PayPalCheckoutOptions — the SDK script must load
// with intent="subscription" + vault=true, which can't share a script load
// with the intent="capture" one-time-order flow storage/expansion still use.
// No Google Pay / hosted card fields here: PayPal Subscriptions' approval
// page is PayPal-account based, unlike a one-time Orders v2 charge.
export function PayPalSubscribeButton({
  clientId, createSubscription, onApprove, onError, onCancel, disabled,
}: Props) {
  return (
    <div className={disabled ? 'opacity-50 pointer-events-none' : ''}>
      <PayPalScriptProvider
        options={{
          clientId,
          intent: 'subscription',
          vault: true,
          components: 'buttons',
        }}
      >
        <PayPalButtons
          disabled={disabled}
          style={{ layout: 'vertical', shape: 'rect', label: 'subscribe' }}
          createSubscription={() => createSubscription()}
          onApprove={async (data) => { if (data.subscriptionID) await onApprove(data.subscriptionID) }}
          onError={(err) => onError(err instanceof Error ? err.message : 'Subscription failed')}
          onCancel={onCancel}
        />
      </PayPalScriptProvider>
      <p className="text-[11px] text-gray-400 text-center m-0 mt-2">
        Payments are processed securely by PayPal.
      </p>
    </div>
  )
}
