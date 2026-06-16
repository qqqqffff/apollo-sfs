import { NativeModules, Platform } from 'react-native';

const { RNGooglePay } = NativeModules;

export const isGooglePaySupported = Platform.OS === 'android' && !!RNGooglePay;

export async function canMakeGooglePayments(gatewayMerchantId: string): Promise<boolean> {
  if (!isGooglePaySupported) return false;
  return RNGooglePay.isReadyToPay(gatewayMerchantId);
}

export async function requestGooglePayment(
  amount: string,
  currencyCode: string,
  merchantName: string,
  gatewayMerchantId: string,
): Promise<string> {
  if (!isGooglePaySupported) throw new Error('Google Pay not available');
  return RNGooglePay.requestPayment(amount, currencyCode, merchantName, gatewayMerchantId);
}
