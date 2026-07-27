// The recurring-billing terms a wallet sheet must disclose to the buyer before
// they authorise a subscription. Both Apple Pay and Google Pay have a required,
// specified shape for this (they render it in their own sheet UI and register
// the subscription in Wallet / Google Pay), so this is the one place the terms
// are described and the two buttons translate it into their own dialect:
//
//   Apple  — ApplePayPaymentRequest.recurringPaymentRequest
//            https://developer.apple.com/documentation/applepayontheweb/applepayrecurringpaymentrequest
//   Google — PaymentDataRequest.recurringTransactionInfo (merchant-initiated
//            transactions)
//            https://developers.google.com/pay/api/web/guides/resources/merchant-initiated-transactions
//
// Passing these is not cosmetic: they are how the buyer consents to a
// merchant-initiated charge. A wallet payment taken with a plain one-time
// request and then billed again later is out of policy on both platforms.
export interface RecurringTerms {
  // Short description of what's being subscribed to, shown in the sheet.
  // Apple: recurringPaymentRequest.paymentDescription (required).
  // Google: recurringTransactionInfo.label.
  description: string
  // Label for the recurring line item, e.g. "Apollo SFS Premium (monthly)".
  itemLabel: string
  // Billing interval. Apple takes lowercase calendar units; Google takes
  // uppercase. Stored here in Apple's form and upcased for Google.
  intervalUnit: 'day' | 'month' | 'year'
  intervalCount: number
  // Absolute https URL where the buyer can change or cancel the subscription.
  // Required by Apple (recurringPaymentRequest.managementURL) and expected by
  // Google (recurringTransactionInfo.managementUrl).
  managementUrl: string
  // Optional localized billing agreement shown before authorisation.
  billingAgreement?: string
  // When the first charge happens. Defaults to now — this flow charges the
  // opening period immediately.
  startDate?: Date
}

// managementUrl builds the absolute URL for the page where a subscription can
// be cancelled. Both wallets require an absolute URL, so this can't just be the
// router path.
export function subscriptionManagementUrl(): string {
  return `${window.location.origin}/client/profile`
}

// billingAgreementText is the disclosure shown in the wallet sheet before the
// buyer authorises. Deliberately explicit that this authorises future charges
// and how to stop them, since the wallet sheet is the last screen before a
// merchant-initiated billing relationship starts.
export function billingAgreementText(priceLabel: string, unit: 'month' | 'year'): string {
  const cadence = unit === 'year' ? 'year' : 'month'
  return (
    `You authorise Apollo SFS to charge this payment method ${priceLabel} every ` +
    `${cadence} until you cancel. Cancel any time from your profile page.`
  )
}
