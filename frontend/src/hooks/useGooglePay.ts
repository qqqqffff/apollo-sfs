import { useCallback, useEffect, useState } from 'react'

// PayPal acts as the Google Pay payment gateway (tokens are processed through
// the same PayPal merchant account as every other method).
export const PAYPAL_MERCHANT_ID = 'HH4449WYNCH5C'

const GOOGLE_PAY_ALLOWED_METHODS = [{
  type: 'CARD',
  parameters: {
    allowedAuthMethods: ['PAN_ONLY', 'CRYPTOGRAM_3DS'],
    allowedCardNetworks: ['AMEX', 'DISCOVER', 'MASTERCARD', 'VISA'],
  },
  tokenizationSpecification: {
    type: 'PAYMENT_GATEWAY',
    parameters: { gateway: 'paypal', gatewayMerchantId: PAYPAL_MERCHANT_ID },
  },
}]

const GOOGLE_PAY_SCRIPT = 'https://pay.google.com/gp/p/js/pay.js'

function paymentsClient() {
  return new (window as any).google.payments.api.PaymentsClient({ environment: 'PRODUCTION' })
}

// useGooglePay loads the Google Pay JS SDK, reports whether the current device
// can pay, and exposes requestToken() to open the Google Pay sheet for a given
// amount and resolve to the opaque payment token. The token is then charged
// server-side (PayPal processes it). Shared by the interest, storage-upgrade,
// and register payment surfaces so the Google Pay wiring lives in one place.
export function useGooglePay() {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    function check() {
      try {
        paymentsClient()
          .isReadyToPay({ apiVersion: 2, apiVersionMinor: 0, allowedPaymentMethods: GOOGLE_PAY_ALLOWED_METHODS })
          .then((res: { result: boolean }) => setReady(res.result))
          .catch(() => {})
      } catch { /* not available */ }
    }
    if ((window as any).google?.payments?.api) {
      check()
      return
    }
    const script = document.createElement('script')
    script.src = GOOGLE_PAY_SCRIPT
    script.async = true
    script.onload = check
    document.head.appendChild(script)
  }, [])

  // requestToken opens the Google Pay sheet for `amount` (major units, e.g.
  // "30.00") and resolves to the payment token, or null if the user cancelled.
  // Non-cancel failures reject so the caller can surface an error.
  const requestToken = useCallback(async (amount: string): Promise<string | null> => {
    try {
      const paymentData = await paymentsClient().loadPaymentData({
        apiVersion: 2,
        apiVersionMinor: 0,
        allowedPaymentMethods: GOOGLE_PAY_ALLOWED_METHODS,
        merchantInfo: { merchantName: 'Apollo SFS' },
        transactionInfo: { totalPriceStatus: 'FINAL', totalPrice: amount, currencyCode: 'USD', countryCode: 'US' },
      })
      return paymentData.paymentMethodData.tokenizationData.token as string
    } catch (err: any) {
      if (err?.statusCode === 'CANCELED') return null
      throw err
    }
  }, [])

  return { ready, requestToken }
}
