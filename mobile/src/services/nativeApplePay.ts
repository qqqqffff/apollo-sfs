import { NativeModules, Platform } from 'react-native';

export interface ApplePayToken {
  version?: string;
  data?: string;
  signature?: string;
  header?: Record<string, string>;
  network?: string;
  displayName?: string;
}

const { RNApplePay } = NativeModules;

export const isApplePaySupported = Platform.OS === 'ios' && !!RNApplePay;

export async function canMakeApplePayments(): Promise<boolean> {
  if (!isApplePaySupported) return false;
  return RNApplePay.canMakePayments();
}

// Presents the Apple Pay sheet and resolves with the tokenized payment once
// the user authorizes it. The sheet STAYS OPEN afterwards — charge the token
// through the backend, then call completeApplePayment(success) so the sheet
// shows the real outcome (Apple's documented flow; it auto-fails the sheet if
// no result arrives within ~30 s of authorization).
export async function requestApplePayment(
  amount: string,
  currencyCode: string,
  merchantIdentifier: string,
  label: string,
): Promise<ApplePayToken> {
  if (!isApplePaySupported) throw new Error('Apple Pay not available');
  const json: string = await RNApplePay.requestPayment(amount, currencyCode, merchantIdentifier, label);
  return JSON.parse(json);
}

// Delivers the PayPal charge outcome to the sheet left open by
// requestApplePayment. Safe to call when the sheet is already gone.
export async function completeApplePayment(success: boolean): Promise<void> {
  if (!isApplePaySupported) return;
  try {
    await RNApplePay.completePayment(success);
  } catch {
    // Sheet already dismissed (timeout/cancel) — nothing to complete.
  }
}
