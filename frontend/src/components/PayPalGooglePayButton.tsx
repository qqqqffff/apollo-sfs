import { useEffect, useRef, useState } from 'react'
import { usePayPalScriptReducer } from '@paypal/react-paypal-js'
import type { RecurringTerms } from './recurringTerms'

const GOOGLE_PAY_JS = 'https://pay.google.com/gp/p/js/pay.js'

function loadGooglePayJs(): Promise<void> {
  return new Promise((resolve, reject) => {
    if ((window as any).google?.payments?.api) return resolve()
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GOOGLE_PAY_JS}"]`)
    if (existing) {
      existing.addEventListener('load', () => resolve())
      existing.addEventListener('error', () => reject(new Error('Google Pay unavailable')))
      return
    }
    const s = document.createElement('script')
    s.src = GOOGLE_PAY_JS
    s.async = true
    s.onload = () => resolve()
    s.onerror = () => reject(new Error('Google Pay unavailable'))
    document.head.appendChild(s)
  })
}

// buildGooglePayTransaction produces the transaction half of the
// PaymentDataRequest. Exactly one of transactionInfo / recurringTransactionInfo
// may be present; the recurring form is what discloses the billing schedule in
// the sheet and enrols the payment method for merchant-initiated charges, so
// without it, billing the card again later is out of policy. Exported for
// tests, since that shape is the compliance surface.
export function buildGooglePayTransaction(opts: {
  countryCode: string
  currencyCode: string
  amount: string
  recurring?: RecurringTerms
}): Record<string, any> {
  const { countryCode, currencyCode, amount, recurring } = opts
  if (!recurring) {
    return {
      transactionInfo: {
        countryCode,
        currencyCode,
        totalPriceStatus: 'FINAL',
        totalPrice: amount,
      },
    }
  }
  return {
    recurringTransactionInfo: {
      countryCode,
      currencyCode,
      label: recurring.description,
      managementUrl: recurring.managementUrl,
      ...(recurring.billingAgreement ? { billingAgreement: recurring.billingAgreement } : {}),
      recurrenceItems: [
        {
          label: recurring.itemLabel,
          price: amount,
          priceStatus: 'FINAL',
          recurrencePeriod: {
            // Google takes uppercase calendar units where Apple takes lowercase.
            unit: recurring.intervalUnit.toUpperCase(),
            count: recurring.intervalCount,
          },
        },
      ],
    },
  }
}

interface Props {
  // Which PayPal environment the SDK is running against. Google Pay MUST use its
  // 'TEST' environment when PayPal is in sandbox and 'PRODUCTION' when live —
  // mismatching them fails with Google's OR_BIBED_11 ("merchant can't accept").
  environment: 'sandbox' | 'live'
  // Currency for the Google Pay sheet (must match the PayPal order's currency).
  currencyCode: string
  // Current amount in major units (e.g. "30.00"), read at click time so the
  // sheet reflects the latest plan selection.
  amount: () => string
  // Creates the PayPal order server-side and resolves to its order id — the
  // SAME endpoint the PayPal buttons/card fields use. PayPal's confirmOrder then
  // attaches the Google Pay payment to this order.
  createOrder: () => Promise<string>
  // Called with the order id after Google Pay authorises it; run the capture.
  onApprove: (orderId: string) => Promise<void> | void
  onError?: (message: string) => void
  // Blocks the click (e.g. no plan selected / a capture in flight).
  enabled: boolean
  // When set, the sheet authorises a merchant-initiated recurring charge
  // rather than a one-off purchase, via recurringTransactionInfo. Omit for
  // ordinary one-time purchases (storage add-ons, deposits).
  //
  // Only honoured when the server says Google Pay subscriptions are usable
  // (subscriptionsEnabled), which is off by default: PayPal doesn't vault the
  // google_pay payment source, so the subscription could never renew, and
  // Google's merchant-initiated transactions are separately an opt-in program.
  // Otherwise the button hides rather than taking a wallet
  // payment the buyer was never shown recurring terms for.
  recurring?: RecurringTerms
  // Whether this PayPal merchant account is enrolled in Google Pay's
  // merchant-initiated transactions program. Only consulted when `recurring`
  // is set. See docs/paypal_setup.md §10.
  subscriptionsEnabled?: boolean
}

// PayPalGooglePayButton renders Google Pay orchestrated by PayPal — PayPal is
// the processor via paypal.Googlepay(); there is no separate Google gateway
// config. MUST be rendered inside a <PayPalScriptProvider> whose options include
// `googlepay` in `components`. Renders nothing if the buyer/merchant isn't
// Google Pay eligible, so the surrounding PayPal buttons/card fields remain the
// fallback.
export function PayPalGooglePayButton({
  environment, currencyCode, amount, createOrder, onApprove, onError, enabled, recurring, subscriptionsEnabled,
}: Props) {
  const [{ isResolved }] = usePayPalScriptReducer()
  const containerRef = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)

  // Latest props for the imperatively-created Google button's click handler.
  const latest = useRef({ currencyCode, amount, createOrder, onApprove, onError, enabled, recurring })
  latest.current = { currencyCode, amount, createOrder, onApprove, onError, enabled, recurring }

  // Asking for a recurring authorisation without being enrolled in Google's
  // MIT program means the sheet request is rejected, so the button is hidden
  // instead — same reasoning as the Apple button's version check: better no
  // Google Pay than a wallet charge with undisclosed recurring terms.
  const blockedForRecurring = !!recurring && !subscriptionsEnabled

  useEffect(() => {
    if (!isResolved || blockedForRecurring) return
    let cancelled = false

    ;(async () => {
      try {
        await loadGooglePayJs()
        if (cancelled) return
        const paypal = (window as any).paypal
        const google = (window as any).google
        if (!paypal?.Googlepay || !google?.payments?.api) return

        const googlepay = paypal.Googlepay()
        const config = await googlepay.config()
        if (cancelled || !config?.isEligible) return

        const client = new google.payments.api.PaymentsClient({
          environment: environment === 'sandbox' ? 'TEST' : 'PRODUCTION',
        })
        const rtp = await client.isReadyToPay({
          apiVersion: config.apiVersion,
          apiVersionMinor: config.apiVersionMinor,
          allowedPaymentMethods: config.allowedPaymentMethods,
        })
        if (cancelled || !rtp?.result) return

        const button = client.createButton({
          onClick: () => runPayment(client, googlepay, config),
          buttonType: 'pay',
          buttonSizeMode: 'fill',
          buttonRadius: 8,
        })
        if (containerRef.current) {
          containerRef.current.innerHTML = ''
          containerRef.current.appendChild(button)
          setVisible(true)
        }
      } catch {
        // Google Pay unavailable (blocked, ineligible, or load failed) — leave
        // the button hidden; the PayPal buttons/card fields still work.
      }
    })()

    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isResolved, blockedForRecurring])

  async function runPayment(client: any, googlepay: any, config: any) {
    const cur = latest.current
    if (!cur.enabled) return
    try {
      const transaction = buildGooglePayTransaction({
        countryCode: config.countryCode || 'US',
        currencyCode: cur.currencyCode,
        amount: cur.amount(),
        recurring: cur.recurring,
      })
      const paymentData = await client.loadPaymentData({
        apiVersion: config.apiVersion,
        apiVersionMinor: config.apiVersionMinor,
        allowedPaymentMethods: config.allowedPaymentMethods,
        merchantInfo: config.merchantInfo,
        ...transaction,
      })

      const orderId = await cur.createOrder()
      const confirm = await googlepay.confirmOrder({
        orderId,
        paymentMethodData: paymentData.paymentMethodData,
      })

      if (confirm?.status === 'PAYER_ACTION_REQUIRED') {
        // 3-D Secure step-up, then re-confirm by capturing.
        await googlepay.initiatePayerAction({ orderId })
      } else if (confirm?.status !== 'APPROVED') {
        cur.onError?.('Google Pay could not be approved — please try another method.')
        return
      }
      await cur.onApprove(orderId)
    } catch (err: any) {
      // The buyer dismissing the sheet is not an error.
      if (err?.statusCode === 'CANCELED') return
      cur.onError?.(err instanceof Error ? err.message : 'Google Pay payment failed')
    }
  }

  return <div ref={containerRef} className={visible ? 'w-full' : 'hidden'} />
}
