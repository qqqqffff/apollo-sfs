package com.apollosfs

import android.app.Activity
import android.content.Intent
import com.facebook.react.bridge.*
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.wallet.*
import org.json.JSONArray
import org.json.JSONObject

class GooglePayModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext), ActivityEventListener {

    companion object {
        private const val REQUEST_CODE = 9901
    }

    private var pendingPromise: Promise? = null

    init {
        reactContext.addActivityEventListener(this)
    }

    override fun getName(): String = "RNGooglePay"

    private fun paymentsClient(activity: Activity): PaymentsClient =
        Wallet.getPaymentsClient(
            activity,
            Wallet.WalletOptions.Builder()
                .setEnvironment(WalletConstants.ENVIRONMENT_PRODUCTION)
                .build()
        )

    private fun allowedPaymentMethods(gatewayMerchantId: String): JSONArray =
        JSONArray().apply {
            put(JSONObject().apply {
                put("type", "CARD")
                put("parameters", JSONObject().apply {
                    put("allowedAuthMethods", JSONArray().apply {
                        put("PAN_ONLY"); put("CRYPTOGRAM_3DS")
                    })
                    put("allowedCardNetworks", JSONArray().apply {
                        put("VISA"); put("MASTERCARD"); put("AMEX"); put("DISCOVER")
                    })
                })
                put("tokenizationSpecification", JSONObject().apply {
                    put("type", "PAYMENT_GATEWAY")
                    put("parameters", JSONObject().apply {
                        put("gateway", "paypal")
                        put("gatewayMerchantId", gatewayMerchantId)
                    })
                })
            })
        }

    @ReactMethod
    fun isReadyToPay(gatewayMerchantId: String, promise: Promise) {
        val activity = reactContext.currentActivity ?: run {
            promise.reject("NO_ACTIVITY", "No activity available"); return
        }
        val request = IsReadyToPayRequest.fromJson(JSONObject().apply {
            put("apiVersion", 2)
            put("apiVersionMinor", 0)
            put("allowedPaymentMethods", allowedPaymentMethods(gatewayMerchantId))
        }.toString())
        paymentsClient(activity).isReadyToPay(request).addOnCompleteListener { task ->
            try { promise.resolve(task.getResult(ApiException::class.java)) }
            catch (e: ApiException) { promise.reject("ERROR", e.message ?: "Unknown error") }
        }
    }

    @ReactMethod
    fun requestPayment(
        amount: String,
        currencyCode: String,
        merchantName: String,
        gatewayMerchantId: String,
        promise: Promise
    ) {
        val activity = reactContext.currentActivity ?: run {
            promise.reject("NO_ACTIVITY", "No activity available"); return
        }
        pendingPromise = promise

        val dataRequest = PaymentDataRequest.fromJson(JSONObject().apply {
            put("apiVersion", 2)
            put("apiVersionMinor", 0)
            put("allowedPaymentMethods", allowedPaymentMethods(gatewayMerchantId))
            put("transactionInfo", JSONObject().apply {
                put("totalPrice", amount)
                put("totalPriceStatus", "FINAL")
                put("currencyCode", currencyCode)
                put("countryCode", "US")
            })
            put("merchantInfo", JSONObject().apply {
                put("merchantName", merchantName)
            })
        }.toString())

        AutoResolveHelper.resolveTask(
            paymentsClient(activity).loadPaymentData(dataRequest),
            activity,
            REQUEST_CODE
        )
    }

    override fun onActivityResult(activity: Activity?, requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode != REQUEST_CODE) return
        val promise = pendingPromise ?: return
        pendingPromise = null

        when (resultCode) {
            Activity.RESULT_OK -> {
                val token = PaymentData.getFromIntent(data!!)?.paymentMethodToken?.token
                if (token != null) promise.resolve(token)
                else promise.reject("ERROR", "No payment token in response")
            }
            Activity.RESULT_CANCELED -> promise.reject("CANCELLED", "User cancelled Google Pay")
            AutoResolveHelper.RESULT_ERROR -> {
                val status = AutoResolveHelper.getStatusFromIntent(data)
                promise.reject("ERROR", "Google Pay error: ${status?.statusMessage}")
            }
        }
    }

    override fun onNewIntent(intent: Intent?) {}
}
