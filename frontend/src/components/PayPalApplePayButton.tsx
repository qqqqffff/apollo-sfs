import { useEffect, useRef, useState } from 'react'
import { usePayPalScriptReducer } from '@paypal/react-paypal-js'
import { FaApplePay } from 'react-icons/fa6'

interface Props {
  // Currency for the Apple Pay sheet (must match the PayPal order's currency).
  currencyCode: string
  // Current amount in major units (e.g. "30.00"), read at click time so the
  // sheet reflects the latest plan selection.
  amount: () => string
  // Creates the PayPal order server-side and resolves to its order id — the
  // SAME endpoint the PayPal buttons/card fields/Google Pay use. PayPal's
  // confirmOrder then attaches the Apple Pay payment to this order.
  createOrder: () => Promise<string>
  // Called with the order id after Apple Pay authorises it; run the capture.
  onApprove: (orderId: string) => Promise<void> | void
  onError?: (message: string) => void
  // Blocks the click (e.g. no plan selected / a capture in flight).
  enabled: boolean
}

// PayPalApplePayButton renders Apple Pay orchestrated by PayPal — PayPal is
// the registered Apple Pay merchant and performs session/merchant validation
// via paypal.Applepay(), so (unlike a from-scratch ApplePaySession
// integration) no Apple merchant identity certificate needs to be configured
// on our side. Mirrors PayPalGooglePayButton's shape/lifecycle. MUST be
// rendered inside a <PayPalScriptProvider> whose options include `applepay`
// in `components`. Renders nothing if the browser/device/buyer isn't Apple
// Pay eligible (non-Safari, no Apple Pay capable device, or PayPal reports
// the merchant/buyer as ineligible), so the surrounding PayPal buttons/card
// fields remain the fallback.
export function PayPalApplePayButton({ currencyCode, amount, createOrder, onApprove, onError, enabled }: Props) {
  const [{ isResolved }] = usePayPalScriptReducer()
  const [eligible, setEligible] = useState(false)
  const [busy, setBusy] = useState(false)
  // Populated once eligibility is confirmed; read imperatively from the click
  // handler rather than kept in state since it holds live PayPal SDK objects.
  const sessionConfig = useRef<{ applepay: any; config: any } | null>(null)

  // Latest props for the imperatively-driven ApplePaySession callbacks.
  const latest = useRef({ currencyCode, amount, createOrder, onApprove, onError, enabled })
  latest.current = { currencyCode, amount, createOrder, onApprove, onError, enabled }

  useEffect(() => {
    if (!isResolved) return
    let cancelled = false

    ;(async () => {
      try {
        const ApplePaySession = (window as any).ApplePaySession
        const paypal = (window as any).paypal
        if (!ApplePaySession?.canMakePayments?.() || !paypal?.Applepay) return

        const applepay = paypal.Applepay()
        const config = await applepay.config()
        if (cancelled || !config?.isEligible) return

        sessionConfig.current = { applepay, config }
        setEligible(true)
      } catch {
        // Apple Pay unavailable (non-Safari, ineligible, or load failed) —
        // leave the button hidden; the PayPal buttons/card fields still work.
      }
    })()

    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isResolved])

  function handleClick() {
    const cur = latest.current
    if (!cur.enabled || busy || !sessionConfig.current) return
    const { applepay, config } = sessionConfig.current
    const ApplePaySession = (window as any).ApplePaySession

    const session = new ApplePaySession(4, {
      countryCode: config.countryCode,
      currencyCode: cur.currencyCode,
      merchantCapabilities: config.merchantCapabilities,
      supportedNetworks: config.supportedNetworks,
      total: { label: 'Apollo SFS', amount: cur.amount(), type: 'final' },
    })
    setBusy(true)

    session.onvalidatemerchant = async (event: any) => {
      try {
        const payload = await applepay.validateMerchant({ validationUrl: event.validationURL })
        session.completeMerchantValidation(payload.merchantSession)
      } catch {
        session.abort()
        setBusy(false)
        cur.onError?.('Apple Pay merchant validation failed.')
      }
    }

    session.onpaymentauthorized = async (event: any) => {
      try {
        const orderId = await cur.createOrder()
        const confirm = await applepay.confirmOrder({
          orderId,
          token: event.payment.token,
          billingContact: event.payment.billingContact,
          shippingContact: event.payment.shippingContact,
        })
        if (confirm?.approveApplePayPaymentError) throw new Error('Apple Pay could not be approved — please try another method.')
        session.completePayment(ApplePaySession.STATUS_SUCCESS)
        await cur.onApprove(orderId)
      } catch (err: any) {
        session.completePayment(ApplePaySession.STATUS_FAILURE)
        cur.onError?.(err instanceof Error ? err.message : 'Apple Pay payment failed')
      } finally {
        setBusy(false)
      }
    }

    session.oncancel = () => setBusy(false)
    session.begin()
  }

  if (!eligible) return null

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={!enabled || busy}
      className="w-full flex items-center justify-center gap-1.5 px-4 py-2.5 text-sm font-semibold bg-black hover:bg-gray-900 text-white rounded-lg disabled:opacity-50 cursor-pointer transition-colors"
    >
      <FaApplePay className="text-2xl" /> Pay
    </button>
  )
}
