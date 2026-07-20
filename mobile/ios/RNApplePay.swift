import Foundation
import PassKit

// RNApplePay presents the native Apple Pay sheet (PKPaymentAuthorizationController)
// following Apple's documented flow and the semantics of PayPal's Apple Pay
// guide (authorize → process with the PSP → complete): requestPayment resolves
// with the tokenized payment while the sheet stays open, and the JS side MUST
// then call completePayment(success) after the PayPal charge so the sheet
// shows the real outcome. Apple auto-fails the sheet if no result is delivered
// within ~30 seconds of authorization.
@objc(RNApplePay)
class RNApplePay: NSObject, PKPaymentAuthorizationControllerDelegate {

  private var resolve: RCTPromiseResolveBlock?
  private var reject: RCTPromiseRejectBlock?
  private var controller: PKPaymentAuthorizationController?
  private var didAuthorize = false
  // Held between didAuthorizePayment and completePayment(_:) so the sheet's
  // success/failure state is driven by the actual PayPal charge result.
  private var authCompletion: ((PKPaymentAuthorizationResult) -> Void)?

  @objc static func requiresMainQueueSetup() -> Bool { false }

  @objc func canMakePayments(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    resolve(PKPaymentAuthorizationController.canMakePayments())
  }

  @objc func requestPayment(
    _ amount: String,
    currencyCode: String,
    merchantIdentifier: String,
    label: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    if self.resolve != nil || self.authCompletion != nil {
      reject("IN_PROGRESS", "An Apple Pay request is already in progress", nil)
      return
    }
    self.resolve = resolve
    self.reject = reject
    self.didAuthorize = false

    let request = PKPaymentRequest()
    request.merchantIdentifier = merchantIdentifier
    // Mirror the networks/capabilities PayPal reports for our merchant in the
    // web button's Applepay config so both surfaces accept the same cards.
    request.supportedNetworks = [.visa, .masterCard, .amex, .discover]
    request.merchantCapabilities = .threeDSecure
    request.countryCode = "US"
    request.currencyCode = currencyCode
    request.paymentSummaryItems = [
      PKPaymentSummaryItem(label: label, amount: NSDecimalNumber(string: amount))
    ]

    let ctrl = PKPaymentAuthorizationController(paymentRequest: request)
    ctrl.delegate = self
    self.controller = ctrl

    DispatchQueue.main.async { ctrl.present(completion: nil) }
  }

  // completePayment delivers the PayPal charge outcome to the sheet held open
  // by didAuthorizePayment. Resolves true when a pending authorization was
  // completed, false when the sheet was already gone (timed out/dismissed).
  @objc func completePayment(
    _ success: Bool,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async {
      guard let completion = self.authCompletion else {
        resolve(false)
        return
      }
      self.authCompletion = nil
      completion(PKPaymentAuthorizationResult(status: success ? .success : .failure, errors: nil))
      if !success {
        // On success iOS shows the checkmark and finishes the sheet itself;
        // after a failure it stays up for a retry we can't service (the token
        // promise is already spent), so dismiss once the error state has
        // been visible for a beat. didFinish handles cleanup.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
          self.controller?.dismiss(completion: nil)
        }
      }
      resolve(true)
    }
  }

  // MARK: – PKPaymentAuthorizationControllerDelegate

  func paymentAuthorizationController(
    _ controller: PKPaymentAuthorizationController,
    didAuthorizePayment payment: PKPayment,
    handler completion: @escaping (PKPaymentAuthorizationResult) -> Void
  ) {
    self.didAuthorize = true

    var tokenDict: [String: Any] = [:]
    if let json = try? JSONSerialization.jsonObject(with: payment.token.paymentData) as? [String: Any] {
      tokenDict = json
    }
    tokenDict["network"] = payment.token.paymentMethod.network?.rawValue ?? ""
    tokenDict["displayName"] = payment.token.paymentMethod.displayName ?? ""

    guard let data = try? JSONSerialization.data(withJSONObject: tokenDict),
          let str = String(data: data, encoding: .utf8) else {
      completion(PKPaymentAuthorizationResult(status: .failure, errors: nil))
      self.reject?("PARSE_ERROR", "Failed to encode Apple Pay token", nil)
      self.resolve = nil
      self.reject = nil
      return
    }

    // Keep the sheet open: JS charges the token through PayPal and reports
    // back via completePayment(success).
    self.authCompletion = completion
    self.resolve?(str)
    self.resolve = nil
    self.reject = nil
  }

  func paymentAuthorizationControllerDidFinish(_ controller: PKPaymentAuthorizationController) {
    controller.dismiss(completion: nil)
    self.controller = nil
    self.authCompletion = nil
    if !self.didAuthorize {
      self.reject?("CANCELLED", "User cancelled Apple Pay", nil)
      self.resolve = nil
      self.reject = nil
    }
  }
}
