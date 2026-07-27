import { buildApplePayPaymentRequest } from '../../components/PayPalApplePayButton'
import { buildGooglePayTransaction } from '../../components/PayPalGooglePayButton'
import type { RecurringTerms } from '../../components/recurringTerms'

// Apple and Google both specify exactly what a wallet sheet must disclose
// before a buyer authorises a merchant-initiated charge. Getting these shapes
// wrong doesn't fail loudly — the sheet renders, the payment succeeds, and the
// buyer simply never sees that they signed up for recurring billing. So the
// required fields are pinned here rather than left to a live Safari check.
//
//   https://developer.apple.com/documentation/applepayontheweb/applepayrecurringpaymentrequest
//   https://developers.google.com/pay/api/web/guides/resources/merchant-initiated-transactions

const TERMS: RecurringTerms = {
  description: 'Apollo SFS Premium',
  itemLabel: 'Premium (monthly)',
  intervalUnit: 'month',
  intervalCount: 1,
  managementUrl: 'https://apollo-sfs.example/client/profile',
  billingAgreement: 'You authorise Apollo SFS to charge $1.00 every month until you cancel.',
  startDate: new Date('2026-07-26T00:00:00Z'),
}

const CONFIG = { countryCode: 'US', merchantCapabilities: ['supports3DS'], supportedNetworks: ['visa'] }

describe('Apple Pay recurring payment request', () => {
  it('declares every field ApplePayRecurringPaymentRequest requires', () => {
    const req = buildApplePayPaymentRequest({
      config: CONFIG, currencyCode: 'USD', amount: '1.00', recurring: TERMS,
    })

    const rpr = req.recurringPaymentRequest
    expect(rpr).toBeDefined()
    // The three required members of the dictionary.
    expect(rpr.paymentDescription).toBe('Apollo SFS Premium')
    expect(rpr.managementURL).toBe('https://apollo-sfs.example/client/profile')
    expect(rpr.regularBilling).toBeDefined()
    expect(rpr.billingAgreement).toBe(TERMS.billingAgreement)
  })

  it('describes the billing cycle on the regularBilling line item', () => {
    const { recurringPaymentRequest } = buildApplePayPaymentRequest({
      config: CONFIG, currencyCode: 'USD', amount: '1.00', recurring: TERMS,
    })

    expect(recurringPaymentRequest.regularBilling).toMatchObject({
      label: 'Premium (monthly)',
      amount: '1.00',
      type: 'final',
      paymentTiming: 'recurring',
      recurringPaymentIntervalUnit: 'month',
      recurringPaymentIntervalCount: 1,
    })
    expect(recurringPaymentRequest.regularBilling.recurringPaymentStartDate).toBeInstanceOf(Date)
    // Open-ended: an end date would cap the subscription at a fixed term.
    expect(recurringPaymentRequest.regularBilling.recurringPaymentEndDate).toBeUndefined()
  })

  it('uses Apple’s lowercase calendar unit for an annual plan', () => {
    const { recurringPaymentRequest } = buildApplePayPaymentRequest({
      config: CONFIG,
      currencyCode: 'USD',
      amount: '10.00',
      recurring: { ...TERMS, intervalUnit: 'year', itemLabel: 'Premium (annual)' },
    })
    expect(recurringPaymentRequest.regularBilling.recurringPaymentIntervalUnit).toBe('year')
  })

  it('omits the recurring request entirely for a one-time purchase', () => {
    const req = buildApplePayPaymentRequest({ config: CONFIG, currencyCode: 'USD', amount: '30.00' })
    expect(req.recurringPaymentRequest).toBeUndefined()
    expect(req.lineItems).toBeUndefined()
    expect(req.total).toMatchObject({ amount: '30.00', type: 'final' })
  })
})

describe('Google Pay recurring transaction info', () => {
  it('sends recurringTransactionInfo instead of transactionInfo', () => {
    const t = buildGooglePayTransaction({
      countryCode: 'US', currencyCode: 'USD', amount: '1.00', recurring: TERMS,
    })
    // Exactly one of the two may be present.
    expect(t.recurringTransactionInfo).toBeDefined()
    expect(t.transactionInfo).toBeUndefined()
  })

  it('carries the management URL and the recurrence schedule', () => {
    const { recurringTransactionInfo } = buildGooglePayTransaction({
      countryCode: 'US', currencyCode: 'USD', amount: '1.00', recurring: TERMS,
    })

    expect(recurringTransactionInfo).toMatchObject({
      countryCode: 'US',
      currencyCode: 'USD',
      label: 'Apollo SFS Premium',
      managementUrl: 'https://apollo-sfs.example/client/profile',
      billingAgreement: TERMS.billingAgreement,
    })
    expect(recurringTransactionInfo.recurrenceItems).toEqual([
      {
        label: 'Premium (monthly)',
        price: '1.00',
        priceStatus: 'FINAL',
        recurrencePeriod: { unit: 'MONTH', count: 1 },
      },
    ])
  })

  it('upcases the calendar unit, unlike Apple', () => {
    const { recurringTransactionInfo } = buildGooglePayTransaction({
      countryCode: 'US',
      currencyCode: 'USD',
      amount: '10.00',
      recurring: { ...TERMS, intervalUnit: 'year' },
    })
    expect(recurringTransactionInfo.recurrenceItems[0].recurrencePeriod.unit).toBe('YEAR')
  })

  it('falls back to a plain transactionInfo for one-time purchases', () => {
    const t = buildGooglePayTransaction({ countryCode: 'US', currencyCode: 'USD', amount: '30.00' })
    expect(t.transactionInfo).toMatchObject({ totalPrice: '30.00', totalPriceStatus: 'FINAL' })
    expect(t.recurringTransactionInfo).toBeUndefined()
  })
})
