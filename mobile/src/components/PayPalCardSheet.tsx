import React, { useRef } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import WebView, { type WebViewMessageEvent } from 'react-native-webview';
import { ArrowLeft } from 'lucide-react-native';
import { PAYPAL_CLIENT_ID } from '../config';
import { colors, radius, spacing } from '../theme';

interface Props {
  amount: string;   // e.g. "30.00"
  currency: string; // ISO 4217, e.g. "USD"
  label: string;
  // When set, the hosted fields pay against this server-created PayPal order
  // instead of creating one client-side — required by flows whose capture
  // endpoint validates a server-side order row (e.g. the interest deposit).
  orderId?: string;
  onSuccess: (orderId: string) => void;
  onError: (message: string) => void;
  onCancel: () => void;
}

function buildHtml(clientId: string, amount: string, currency: string, label: string, serverOrderId?: string): string {
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
    .field-wrap { background: #fff; border: 1.5px solid #e5e7eb; border-radius: 10px; height: 48px; padding: 0 14px; margin-bottom: 14px; display: flex; align-items: center; }
    .field-wrap.focused { border-color: #3b82f6; }
    .hosted-field { height: 100%; width: 100%; }
    .row { display: flex; gap: 10px; }
    .row > div { flex: 1; }
    .summary { background: #eff6ff; border: 1.5px solid #bfdbfe; border-radius: 10px; padding: 12px 14px; margin-bottom: 18px; }
    .summary-label { font-size: 14px; font-weight: 600; color: #1e40af; }
    .btn { width: 100%; padding: 14px; background: #003087; border: none; border-radius: 10px; cursor: pointer; font-size: 16px; font-weight: 700; margin-top: 4px; color: #fff; }
    .btn:disabled { opacity: 0.45; cursor: default; }
    .btn-inner { display: flex; align-items: center; justify-content: center; }
    .pp-pay { color: #009cde; font-weight: 400; letter-spacing: 0.2px; }
    .pp-pal { color: #009cde; font-weight: 900; letter-spacing: 0.2px; }
    .error { color: #dc2626; font-size: 13px; margin-bottom: 12px; display: none; padding: 8px 10px; background: #fef2f2; border-radius: 8px; }
    .spinner { display: none; text-align: center; padding: 10px 0; color: #6b7280; font-size: 13px; }
    .notice { font-size: 13px; color: #6b7280; text-align: center; padding: 24px 0; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="summary"><div class="summary-label">${safeLabel}</div></div>

  <div id="fields-section" style="display:none">
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
  </div>

  <div id="loading-msg" class="notice">Loading secure card form…</div>

  <script>
    (function() {
      var AMOUNT = ${JSON.stringify(amount)};
      var CURRENCY = ${JSON.stringify(currency)};
      var SERVER_ORDER_ID = ${JSON.stringify(serverOrderId ?? null)};

      function post(msg) { window.ReactNativeWebView.postMessage(JSON.stringify(msg)); }

      function errDetail(err) {
        if (!err) return 'Unknown error';
        var parts = [];
        if (err.message) parts.push(err.message);
        if (err.details && Array.isArray(err.details)) {
          err.details.forEach(function(d) {
            parts.push((d.field || '') + ' ' + (d.issue || '') + (d.description ? ': ' + d.description : ''));
          });
        }
        if (err.debug_id) parts.push('debug_id: ' + err.debug_id);
        var text = parts.join(' | ').trim() || JSON.stringify(err);
        return text;
      }

      function showError(msg) {
        var el = document.getElementById('err');
        el.textContent = msg;
        el.style.display = 'block';
        document.getElementById('spinner').style.display = 'none';
        document.getElementById('pay-btn').disabled = false;
        post({ type: 'LOG', message: 'WebView error: ' + msg });
      }

      window.onerror = function(msg, src, line, col, err) {
        var detail = msg + (err ? ' | ' + errDetail(err) : '') + ' (' + src + ':' + line + ')';
        post({ type: 'LOG', message: 'WebView uncaught: ' + detail });
      };

      if (!paypal.HostedFields.isEligible()) {
        var ineligMsg = '[PAYPAL INELIGIBLE] Advanced Credit and Debit Card Payments is not enabled for this sandbox app. ' +
          'Go to developer.paypal.com → Apps & Credentials → your app → Features → ' +
          'Advanced Credit and Debit Card Payments and enable it.';
        document.getElementById('loading-msg').textContent = ineligMsg;
        post({ type: 'INELIGIBLE', message: ineligMsg });
        return;
      }

      paypal.HostedFields.render({
        createOrder: function(data, actions) {
          if (SERVER_ORDER_ID) {
            post({ type: 'LOG', message: 'createOrder — using server-created order ' + SERVER_ORDER_ID });
            return Promise.resolve(SERVER_ORDER_ID);
          }
          post({ type: 'LOG', message: 'createOrder called — creating PayPal order client-side' });
          return actions.order.create({
            intent: 'CAPTURE',
            purchase_units: [{ amount: { value: AMOUNT, currency_code: CURRENCY } }]
          }).then(function(orderId) {
            post({ type: 'LOG', message: 'Order created: ' + orderId });
            return orderId;
          }).catch(function(err) {
            var detail = errDetail(err);
            post({ type: 'LOG', message: 'createOrder failed: ' + detail });
            throw err;
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
        post({ type: 'LOG', message: 'HostedFields rendered successfully' });
        document.getElementById('loading-msg').style.display = 'none';
        document.getElementById('fields-section').style.display = 'block';

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
          post({ type: 'LOG', message: 'Submitting card fields…' });
          hf.submit({ contingencies: ['SCA_WHEN_REQUIRED'] }).then(function(payload) {
            post({ type: 'LOG', message: 'hf.submit approved — orderId: ' + payload.orderId });
            post({ type: 'APPROVED', orderId: payload.orderId });
          }).catch(function(err) {
            var detail = errDetail(err);
            post({ type: 'LOG', message: 'hf.submit failed: ' + detail });
            showError(detail);
          });
        });
      }).catch(function(err) {
        var detail = errDetail(err);
        document.getElementById('loading-msg').textContent = '[RENDER ERROR] ' + detail;
        post({ type: 'ERROR', message: '[HostedFields.render failed] ' + detail });
      });
    })();
  </script>
</body>
</html>`;
}

// Renders inline — no Modal wrapper. Mount this inside the parent modal's View
// when the card form should be visible; unmount or hide it otherwise.
export default function PayPalCardSheet({ amount, currency, label, orderId, onSuccess, onError, onCancel }: Props) {
  const webViewRef = useRef<WebView>(null);

  const handleMessage = (event: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === 'LOG') {
        console.log('[PayPalCardSheet]', msg.message);
        return;
      }
      if (msg.type === 'APPROVED') {
        onSuccess(msg.orderId);
      } else if (msg.type === 'ERROR' || msg.type === 'INELIGIBLE') {
        console.error('[PayPalCardSheet] fatal:', msg.message);
        onError(msg.message ?? 'An error occurred.');
      }
    } catch {}
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onCancel} style={styles.backBtn} hitSlop={12}>
          <ArrowLeft size={20} color={colors.textPrimary} strokeWidth={2} />
        </TouchableOpacity>
        <Text style={styles.title}>Pay by Card</Text>
        <View style={{ width: 36 }} />
      </View>

      <WebView
        ref={webViewRef}
        source={{ html: buildHtml(PAYPAL_CLIENT_ID, amount, currency, label, orderId), baseUrl: 'https://apollo-sfs.com' }}
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
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: 14,
    backgroundColor: colors.surface,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  backBtn: { width: 36, alignItems: 'flex-start' },
  title: { fontSize: 17, fontWeight: '600', color: colors.textPrimary },
  webView: { flex: 1 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  loadingText: { fontSize: 14, color: colors.textSecondary },
});
