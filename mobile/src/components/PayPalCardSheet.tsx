import React, { useRef } from 'react';
import {
  ActivityIndicator,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import WebView, { type WebViewMessageEvent } from 'react-native-webview';
import { X } from 'lucide-react-native';
import { PAYPAL_CLIENT_ID } from '../config';
import { colors, radius, spacing } from '../theme';

interface Props {
  visible: boolean;
  // Amount and currency are used by the JS SDK to create the order client-side.
  // Raw card data never touches our servers — PayPal's iframes collect it directly.
  amount: string;   // e.g. "30.00"
  currency: string; // ISO 4217, e.g. "USD"
  label: string;    // shown as a summary above the card fields
  onSuccess: (orderId: string) => void;
  onError: (message: string) => void;
  onCancel: () => void;
}

function buildHtml(clientId: string, amount: string, currency: string, label: string): string {
  const safeLabel = label.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
  <script src="https://www.paypal.com/sdk/js?client-id=${clientId}&components=hosted-fields&intent=capture&currency=${currency}"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, sans-serif; background: #f9fafb; padding: 20px; }
    .label { font-size: 11px; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.6px; margin-bottom: 6px; }
    .field-wrap { background: #fff; border: 1.5px solid #e5e7eb; border-radius: 10px; height: 48px; padding: 0 14px; margin-bottom: 14px; }
    .field-wrap.focused { border-color: #3b82f6; }
    .hosted-field { height: 100%; }
    .row { display: flex; gap: 10px; }
    .row > div { flex: 1; }
    .summary { background: #eff6ff; border: 1.5px solid #bfdbfe; border-radius: 10px; padding: 12px 14px; margin-bottom: 18px; }
    .summary-label { font-size: 14px; font-weight: 600; color: #1e40af; }
    .btn { width: 100%; padding: 14px; background: #003087; border: none; border-radius: 10px; cursor: pointer; font-size: 16px; font-weight: 700; margin-top: 4px; color: #fff; }
    .btn:disabled { opacity: 0.45; cursor: default; }
    .btn-inner { display: flex; align-items: center; justify-content: center; gap: 0; }
    .pp-pay { color: #009cde; font-weight: 400; letter-spacing: 0.2px; }
    .pp-pal { color: #009cde; font-weight: 900; letter-spacing: 0.2px; }
    .error { color: #dc2626; font-size: 13px; margin-bottom: 12px; display: none; padding: 8px 10px; background: #fef2f2; border-radius: 8px; }
    .spinner { display: none; text-align: center; padding: 10px 0; color: #6b7280; font-size: 13px; }
  </style>
</head>
<body>
  <div class="summary"><div class="summary-label">${safeLabel}</div></div>

  <div class="label">Card Number</div>
  <div class="field-wrap" id="wrap-number"><div id="card-number" class="hosted-field"></div></div>

  <div class="row">
    <div>
      <div class="label">Expiry</div>
      <div class="field-wrap" id="wrap-expiry"><div id="expiry-date" class="hosted-field"></div></div>
    </div>
    <div>
      <div class="label">CVV</div>
      <div class="field-wrap" id="wrap-cvv"><div id="cvv" class="hosted-field"></div></div>
    </div>
  </div>

  <div class="label">Name on Card</div>
  <div class="field-wrap" id="wrap-name"><div id="cardholder-name" class="hosted-field"></div></div>

  <div class="error" id="err"></div>
  <div class="spinner" id="spinner">Processing…</div>

  <button class="btn" id="pay-btn" disabled>
    <div class="btn-inner"><span class="pp-pay">Pay</span><span class="pp-pal">Pal</span></div>
  </button>

  <script>
    (function() {
      var AMOUNT = ${JSON.stringify(amount)};
      var CURRENCY = ${JSON.stringify(currency)};

      function post(msg) { window.ReactNativeWebView.postMessage(JSON.stringify(msg)); }

      function showError(msg) {
        var el = document.getElementById('err');
        el.textContent = msg;
        el.style.display = 'block';
        document.getElementById('spinner').style.display = 'none';
        document.getElementById('pay-btn').disabled = false;
      }

      if (!paypal.HostedFields.isEligible()) {
        post({ type: 'INELIGIBLE', message: 'ACDC not eligible — ensure Advanced Credit and Debit Cards is enabled for this PayPal sandbox app in the developer dashboard.' });
        return;
      }

      paypal.HostedFields.render({
        // Order is created client-side through the JS SDK — no backend call needed.
        createOrder: function(data, actions) {
          return actions.order.create({
            intent: 'CAPTURE',
            purchase_units: [{ amount: { value: AMOUNT, currency_code: CURRENCY } }]
          });
        },
        styles: {
          input: { 'font-size': '15px', color: '#111827', 'font-family': '-apple-system, sans-serif' },
          ':focus': { color: '#111827' },
          '.invalid': { color: '#dc2626' },
          '::placeholder': { color: '#9ca3af' },
        },
        fields: {
          number:         { selector: '#card-number',     placeholder: '•••• •••• •••• ••••' },
          expirationDate: { selector: '#expiry-date',     placeholder: 'MM / YY' },
          cvv:            { selector: '#cvv',             placeholder: '•••' },
          cardholderName: { selector: '#cardholder-name', placeholder: 'Full name' },
        },
      }).then(function(hf) {
        var btn = document.getElementById('pay-btn');
        btn.disabled = false;

        var wrapMap = { cardNumber: 'wrap-number', expirationDate: 'wrap-expiry', cvv: 'wrap-cvv', cardholderName: 'wrap-name' };
        hf.on('focus', function(e) {
          var w = document.getElementById(wrapMap[e.emittedBy]);
          if (w) w.classList.add('focused');
        });
        hf.on('blur', function(e) {
          var w = document.getElementById(wrapMap[e.emittedBy]);
          if (w) w.classList.remove('focused');
        });

        btn.addEventListener('click', function() {
          btn.disabled = true;
          document.getElementById('err').style.display = 'none';
          document.getElementById('spinner').style.display = 'block';

          hf.submit({ contingencies: ['SCA_WHEN_REQUIRED'] }).then(function(payload) {
            post({ type: 'APPROVED', orderId: payload.orderId });
          }).catch(function(err) {
            showError(err.message || 'Card payment failed. Please try again.');
          });
        });
      }).catch(function(err) {
        post({ type: 'ERROR', message: err.message || 'Could not initialize card fields.' });
      });
    })();
  </script>
</body>
</html>`;
}

export default function PayPalCardSheet({ visible, amount, currency, label, onSuccess, onError, onCancel }: Props) {
  const webViewRef = useRef<WebView>(null);

  const handleMessage = (event: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === 'APPROVED') {
        onSuccess(msg.orderId);
      } else if (msg.type === 'ERROR' || msg.type === 'INELIGIBLE') {
        onError(msg.message ?? 'An error occurred.');
      }
    } catch {}
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onCancel}>
      <View style={styles.root}>
        <View style={styles.header}>
          <TouchableOpacity onPress={onCancel} style={styles.closeBtn} hitSlop={12}>
            <X size={20} color={colors.textPrimary} strokeWidth={2} />
          </TouchableOpacity>
          <Text style={styles.title}>Pay by Card</Text>
          <View style={{ width: 36 }} />
        </View>

        <WebView
          ref={webViewRef}
          source={{ html: buildHtml(PAYPAL_CLIENT_ID, amount, currency, label), baseUrl: 'https://apollo-sfs.com' }}
          onMessage={handleMessage}
          startInLoadingState
          renderLoading={() => (
            <View style={styles.loading}>
              <ActivityIndicator size="large" color={colors.primary} />
              <Text style={styles.loadingText}>Loading secure card form…</Text>
            </View>
          )}
          style={styles.webView}
          scrollEnabled
          javaScriptEnabled
          domStorageEnabled
          originWhitelist={['*']}
          allowsInlineMediaPlayback
          mixedContentMode="compatibility"
          allowUniversalAccessFromFileURLs
        />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: 14,
    backgroundColor: colors.surface,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  closeBtn: { width: 36, alignItems: 'flex-start' },
  title: { fontSize: 17, fontWeight: '600', color: colors.textPrimary },
  webView: { flex: 1 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  loadingText: { fontSize: 14, color: colors.textSecondary },
});
