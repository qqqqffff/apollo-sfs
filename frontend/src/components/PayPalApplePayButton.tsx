import { useEffect, useRef, useState } from 'react'
import type { RecurringTerms } from './recurringTerms'

// Apple's official Apple Pay JS SDK — provides the <apple-pay-button> custom
// element used below (required by the PayPal integration guide).
const APPLE_PAY_SDK_SRC = 'https://applepay.cdn-apple.com/jsapi/v1/apple-pay-sdk.js'

// The <apple-pay-button> custom element registered by Apple's SDK script.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      'apple-pay-button': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        buttonstyle?: string
        type?: string
        locale?: string
      }
    }
  }
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`)
    if (existing) {
      if (existing.dataset.loaded === 'true') return resolve()
      existing.addEventListener('load', () => resolve())
      existing.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)))
      return
    }
    const s = document.createElement('script')
    s.src = src
    s.async = true
    s.onload = () => { s.dataset.loaded = 'true'; resolve() }
    s.onerror = () => reject(new Error(`Failed to load ${src}`))
    document.head.appendChild(s)
  })
}

// Loads the PayPal Web SDK v6 core and returns its namespace. The v6 core is
// coexistence-aware: when the legacy paypal.com/sdk/js (still used by the
// Google Pay button and hosted card fields) already owns window.paypal, v6
// attaches itself as window.paypal.v6 instead — so the namespace is captured
// here at load time rather than read from window.paypal later, where a
// legacy-SDK load could race it. Cached per environment (sandbox/live load
// from different hosts).
const v6ByEnv = new Map<string, Promise<any>>()
function loadPayPalV6(environment: 'sandbox' | 'live'): Promise<any> {
  let cached = v6ByEnv.get(environment)
  if (!cached) {
    const host = environment === 'sandbox' ? 'https://www.sandbox.paypal.com' : 'https://www.paypal.com'
    cached = loadScript(`${host}/web-sdk/v6/core`).then(() => {
      const w = window as any
      const ns = typeof w.paypal?.v6?.createInstance === 'function' ? w.paypal.v6 : w.paypal
      if (typeof ns?.createInstance !== 'function') throw new Error('PayPal v6 SDK unavailable')
      return ns
    })
    v6ByEnv.set(environment, cached)
  }
  return cached
}

interface Props {
  // Which PayPal environment to load the v6 SDK from — must match the
  // environment the client token was minted against.
  environment: 'sandbox' | 'live'
  // Currency for the Apple Pay sheet (must match the PayPal order's currency).
  currencyCode: string
  // Current amount in major units (e.g. "30.00"), read at click time so the
  // sheet reflects the latest plan selection.
  amount: () => string
  // Resolves a browser-safe client token for paypal.createInstance — see
  // getPayPalClientToken (protected surfaces) / getPublicPayPalClientToken
  // (public interest page).
  getClientToken: () => Promise<string>
  // Creates the PayPal order server-side and resolves to its order id — the
  // SAME endpoint the PayPal buttons/card fields/Google Pay use. PayPal's
  // confirmOrder then attaches the Apple Pay payment to this order.
  createOrder: () => Promise<string>
  // Called with the order id after PayPal confirms the Apple Pay token; runs
  // the server-side capture. Runs BEFORE the sheet is completed so the
  // checkmark only shows once the money actually moved (per the guide).
  onApprove: (orderId: string) => Promise<void> | void
  onError?: (message: string) => void
  // Blocks the click (e.g. no plan selected / a capture in flight).
  enabled: boolean
  // When set, the sheet is a subscription authorisation rather than a one-off
  // charge: Apple renders the billing terms, registers the subscription in
  // Wallet, and issues a merchant token intended for repeat billing. Omit for
  // ordinary one-time purchases (storage add-ons, deposits).
  recurring?: RecurringTerms
}

// Apple Pay JS API version that introduced recurringPaymentRequest (macOS 13 /
// iOS 16). Version 4 is plenty for the one-time sheet and is kept for it so
// older Safari still gets Apple Pay; a subscription sheet has to negotiate 14
// or not run at all — see the eligibility check below.
const APPLE_PAY_VERSION_ONE_TIME = 4
const APPLE_PAY_VERSION_RECURRING = 14

// recurringLineItem builds the ApplePayLineItem describing the billing cycle.
// Apple's own examples pass Date objects, which is what the fields are typed
// as. No recurringPaymentEndDate: the subscription runs until cancelled, and
// Apple treats an absent end date as open-ended.
function recurringLineItem(terms: RecurringTerms, amount: string) {
  return {
    label: terms.itemLabel,
    amount,
    type: 'final',
    paymentTiming: 'recurring',
    recurringPaymentStartDate: terms.startDate ?? new Date(),
    recurringPaymentIntervalUnit: terms.intervalUnit,
    recurringPaymentIntervalCount: terms.intervalCount,
  }
}

// buildApplePayPaymentRequest assembles the ApplePayPaymentRequest handed to
// ApplePaySession. Exported for tests: the recurring half of this shape is a
// compliance requirement (ApplePayRecurringPaymentRequest mandates
// paymentDescription, regularBilling and managementURL), so it's worth pinning
// independently of the SDK plumbing around it.
export function buildApplePayPaymentRequest(opts: {
  config: { countryCode?: string; merchantCapabilities?: unknown; supportedNetworks?: unknown } | null
  currencyCode: string
  amount: string
  recurring?: RecurringTerms
}): Record<string, any> {
  const { config, currencyCode, amount, recurring } = opts
  const request: Record<string, any> = {
    countryCode: config?.countryCode ?? 'US',
    currencyCode,
    merchantCapabilities: config?.merchantCapabilities,
    supportedNetworks: config?.supportedNetworks,
    requiredBillingContactFields: ['name', 'postalAddress'],
    total: { label: 'Apollo SFS', amount, type: 'final' },
  }
  if (recurring) {
    // Declaring the terms here is what makes this a subscription
    // authorisation: Apple shows the billing schedule in the sheet, adds the
    // subscription to Wallet under managementURL, and issues a merchant token
    // meant to be billed again.
    request.recurringPaymentRequest = {
      paymentDescription: recurring.description,
      regularBilling: recurringLineItem(recurring, amount),
      managementURL: recurring.managementUrl,
      ...(recurring.billingAgreement ? { billingAgreement: recurring.billingAgreement } : {}),
    }
    // Mirror the schedule on the sheet's own line items so the total isn't
    // presented as a bare one-off charge next to the recurring disclosure.
    request.lineItems = [recurringLineItem(recurring, amount)]
  }
  return request
}

// PayPalApplePayButton renders Apple Pay orchestrated by PayPal via the Web
// SDK v6, following https://developer.paypal.com/apple-pay/integrate —
// createInstance({ clientToken, components: ['applepay-payments'] }),
// createApplePayOneTimePaymentSession(), and Apple's official
// <apple-pay-button> element. PayPal is the registered Apple Pay merchant and
// performs merchant validation, so no Apple merchant identity certificate is
// configured on our side. Loads its own SDK (independent of the legacy
// PayPalScriptProvider the sibling buttons use) and renders nothing if the
// browser/device/buyer isn't Apple Pay eligible, so the surrounding PayPal
// buttons/card fields remain the fallback.
export function PayPalApplePayButton({
  environment, currencyCode, amount, getClientToken, createOrder, onApprove, onError, enabled, recurring,
}: Props) {
  const [eligible, setEligible] = useState(false)
  const [busy, setBusy] = useState(false)
  // Populated once eligibility is confirmed; read imperatively from the click
  // handler rather than kept in state since it holds live PayPal SDK objects.
  const paypalSession = useRef<{ session: any; config: any } | null>(null)

  // Latest props for the imperatively-driven ApplePaySession callbacks.
  const latest = useRef({ currencyCode, amount, getClientToken, createOrder, onApprove, onError, enabled, recurring })
  latest.current = { currencyCode, amount, getClientToken, createOrder, onApprove, onError, enabled, recurring }

  // A subscription sheet needs API version 14 for recurringPaymentRequest.
  // Where that isn't available the button hides rather than falling back to a
  // one-time sheet: the payment method would still be saved and billed again
  // later, but the buyer would never have been shown the recurring terms — the
  // exact undisclosed merchant-initiated charge Apple's guide exists to
  // prevent. The other options (PayPal, Google Pay, card) still cover them.
  const needsRecurringSupport = !!recurring

  useEffect(() => {
    let cancelled = false

    ;(async () => {
      try {
        const ApplePaySession = (window as any).ApplePaySession
        if (!ApplePaySession?.canMakePayments?.()) return
        if (needsRecurringSupport && !ApplePaySession.supportsVersion?.(APPLE_PAY_VERSION_RECURRING)) return

        const [paypal] = await Promise.all([
          loadPayPalV6(environment),
          loadScript(APPLE_PAY_SDK_SRC),
        ])
        if (cancelled) return

        const clientToken = await latest.current.getClientToken()
        if (cancelled) return

        const sdkInstance = await paypal.createInstance({
          clientToken,
          components: ['applepay-payments'],
          pageType: 'checkout',
        })
        const session = await sdkInstance.createApplePayOneTimePaymentSession()
        const config = await session.config()
        if (cancelled || config?.isEligible === false) return

        paypalSession.current = { session, config }
        setEligible(true)
      } catch {
        // Apple Pay unavailable (non-Safari, ineligible, or load failed) —
        // leave the button hidden; the PayPal buttons/card fields still work.
      }
    })()

    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [environment, needsRecurringSupport])

  function handleClick() {
    const cur = latest.current
    if (!cur.enabled || busy || !paypalSession.current) return
    const { session: paypalSess, config } = paypalSession.current
    const ApplePaySession = (window as any).ApplePaySession

    // The ApplePaySession MUST be created synchronously inside the user
    // gesture handler, one per click.
    const paymentRequest = buildApplePayPaymentRequest({
      config,
      currencyCode: cur.currencyCode,
      amount: cur.amount(),
      recurring: cur.recurring,
    })
    const version = cur.recurring ? APPLE_PAY_VERSION_RECURRING : APPLE_PAY_VERSION_ONE_TIME
    const session = new ApplePaySession(version, paymentRequest)
    setBusy(true)

    session.onvalidatemerchant = (event: any) => {
      paypalSess
        .validateMerchant({ validationUrl: event.validationURL })
        .then((payload: any) => session.completeMerchantValidation(payload.merchantSession))
        .catch(() => {
          session.abort()
          setBusy(false)
          cur.onError?.('Apple Pay merchant validation failed.')
        })
    }

    session.onpaymentmethodselected = () => {
      // Nothing about the terms depends on which card was picked, so the
      // update just re-states what the sheet already shows. lineItems have to
      // be repeated alongside the total or the sheet drops them.
      session.completePaymentMethodSelection({
        newTotal: paymentRequest.total,
        ...(paymentRequest.lineItems ? { newLineItems: paymentRequest.lineItems } : {}),
      })
    }

    session.onpaymentauthorized = async (event: any) => {
      try {
        const orderId = await cur.createOrder()
        await paypalSess.confirmOrder({
          orderId,
          token: event.payment.token,
          billingContact: event.payment.billingContact,
          shippingContact: event.payment.shippingContact,
        })
        // Capture before completing the sheet so the success checkmark means
        // the payment really went through.
        await cur.onApprove(orderId)
        session.completePayment({ status: ApplePaySession.STATUS_SUCCESS })
      } catch (err: any) {
        session.completePayment({ status: ApplePaySession.STATUS_FAILURE })
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
    <apple-pay-button
      buttonstyle="black"
      type="plain"
      locale="en-US"
      onClick={handleClick}
      style={{
        display: 'block',
        width: '100%',
        ['--apple-pay-button-width' as any]: '100%',
        ['--apple-pay-button-height' as any]: '40px',
        ['--apple-pay-button-border-radius' as any]: '8px',
        opacity: !enabled || busy ? 0.5 : 1,
        pointerEvents: !enabled || busy ? 'none' : 'auto',
      }}
    />
  )
}
