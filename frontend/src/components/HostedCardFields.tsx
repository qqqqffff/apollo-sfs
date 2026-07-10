import { useState } from 'react'
import {
  PayPalScriptProvider,
  PayPalCardFieldsProvider,
  PayPalNameField,
  PayPalNumberField,
  PayPalExpiryField,
  PayPalCVVField,
  usePayPalCardFields,
  type PayPalCardFieldsStateObject,
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
        <CardDetailsAndAddress submitLabel={submitLabel} disabled={disabled} onError={onError} />
      </PayPalCardFieldsProvider>
    </PayPalScriptProvider>
  )
}

// Shared with the plain <input> billing fields below so the hosted PayPal
// iframes (card number/expiry/CVV/name) read as the same form as everything
// else: same height, border, radius and focus ring. `focus-within` lights the
// ring up when the iframe inside gets focus, since the div itself never does.
const inputClass = 'border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent'
const hostedFieldBaseClass = 'h-[38px] px-3 border rounded-lg focus-within:ring-2 focus-within:ring-blue-500 focus-within:border-transparent transition-colors'

// Injected into the hosted iframes so their text matches the surrounding
// text-sm / text-gray-900 inputs (PayPal only accepts styling this way — the
// iframe content is cross-origin).
const CARD_FIELD_STYLE = {
  input: { 'font-size': '14px', 'font-family': 'inherit', color: '#111827' },
  '::placeholder': { color: '#9ca3af' },
}

function hostedFieldClass(field?: { isEmpty: boolean; isValid: boolean }) {
  const invalid = !!field && !field.isEmpty && !field.isValid
  return `${hostedFieldBaseClass} ${invalid ? 'border-red-300' : 'border-gray-300'}`
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">{children}</span>
}

// Cardholder name lives inside PayPal's hosted NameField, so we can't render
// our own <input> for it or read its value — only whether it's empty, via
// getState(). Billing address isn't a hosted field at all; PayPal expects it
// as plain values passed to submit(), so it's collected here as ordinary
// controlled inputs. Both are required so declines get AVS/CVV-backed
// liability shift instead of running as card-only charges.
function CardDetailsAndAddress({
  submitLabel, disabled, onError,
}: { submitLabel: string; disabled?: boolean; onError?: (message: string) => void }) {
  const { cardFieldsForm } = usePayPalCardFields()
  const [submitting, setSubmitting] = useState(false)
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [fieldStates, setFieldStates] = useState<PayPalCardFieldsStateObject['fields'] | null>(null)
  const [address, setAddress] = useState({
    addressLine1: '', addressLine2: '', city: '', state: '', postalCode: '',
  })

  function handleFieldChange(data: PayPalCardFieldsStateObject) {
    setFieldStates(data.fields)
  }

  async function handleSubmit() {
    if (!cardFieldsForm) {
      onError?.('Card fields are still loading — please try again.')
      return
    }
    setFieldError(null)
    if (!address.addressLine1.trim() || !address.city.trim() || !address.state.trim() || !address.postalCode.trim()) {
      setFieldError('Billing address is required.')
      return
    }
    const state = await cardFieldsForm.getState()
    if (state.fields.cardNameField.isEmpty) {
      setFieldError('Name on card is required.')
      return
    }
    setSubmitting(true)
    try {
      // Rejects if the card is invalid/incomplete or the order is declined;
      // otherwise resolves and the provider's onApprove fires with the order id.
      // The billing address is only used to enrich this order's AVS check —
      // GeoIP already restricts the site to US traffic (see nginx CLAUDE.md),
      // so country is fixed rather than collected.
      await cardFieldsForm.submit({
        billingAddress: {
          addressLine1: address.addressLine1.trim(),
          addressLine2: address.addressLine2.trim() || undefined,
          adminArea2: address.city.trim(),
          adminArea1: address.state.trim().toUpperCase(),
          postalCode: address.postalCode.trim(),
          countryCode: 'US',
        },
      })
    } catch (err) {
      onError?.(err instanceof Error ? err.message : 'Card payment failed — check your details and try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="mt-3 flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <SectionLabel>Card details</SectionLabel>
        <PayPalNameField
          placeholder="Name on card"
          style={CARD_FIELD_STYLE}
          inputEvents={{ onChange: handleFieldChange }}
          className={hostedFieldClass(fieldStates?.cardNameField)}
        />
        <PayPalNumberField
          placeholder="Card number"
          style={CARD_FIELD_STYLE}
          inputEvents={{ onChange: handleFieldChange }}
          className={hostedFieldClass(fieldStates?.cardNumberField)}
        />
        <div className="grid grid-cols-2 gap-2">
          <PayPalExpiryField
            placeholder="MM / YY"
            style={CARD_FIELD_STYLE}
            inputEvents={{ onChange: handleFieldChange }}
            className={hostedFieldClass(fieldStates?.cardExpiryField)}
          />
          <PayPalCVVField
            placeholder="CVV"
            style={CARD_FIELD_STYLE}
            inputEvents={{ onChange: handleFieldChange }}
            className={hostedFieldClass(fieldStates?.cardCvvField)}
          />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <SectionLabel>Billing address</SectionLabel>
        <input
          value={address.addressLine1}
          onChange={(e) => setAddress((a) => ({ ...a, addressLine1: e.target.value }))}
          placeholder="Address line 1"
          autoComplete="address-line1"
          required
          className={inputClass}
        />
        <input
          value={address.addressLine2}
          onChange={(e) => setAddress((a) => ({ ...a, addressLine2: e.target.value }))}
          placeholder="Address line 2 (optional)"
          autoComplete="address-line2"
          className={inputClass}
        />
        <div className="grid grid-cols-[1fr_72px] gap-2">
          <input
            value={address.city}
            onChange={(e) => setAddress((a) => ({ ...a, city: e.target.value }))}
            placeholder="City"
            autoComplete="address-level2"
            required
            className={inputClass}
          />
          <input
            value={address.state}
            onChange={(e) => setAddress((a) => ({ ...a, state: e.target.value.toUpperCase() }))}
            placeholder="State"
            autoComplete="address-level1"
            maxLength={2}
            required
            className={inputClass}
          />
        </div>
        <input
          value={address.postalCode}
          onChange={(e) => setAddress((a) => ({ ...a, postalCode: e.target.value }))}
          placeholder="ZIP code"
          autoComplete="postal-code"
          required
          className={inputClass}
        />
      </div>

      {fieldError && <p className="text-xs text-red-500 m-0">{fieldError}</p>}
      <button
        type="button"
        onClick={handleSubmit}
        disabled={disabled || submitting}
        className="w-full mt-1 px-4 py-3 text-sm font-semibold bg-blue-600 hover:bg-blue-700 text-white rounded-xl disabled:opacity-50 transition-colors cursor-pointer"
      >
        {submitting ? 'Processing…' : submitLabel}
      </button>
    </div>
  )
}
