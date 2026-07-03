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
