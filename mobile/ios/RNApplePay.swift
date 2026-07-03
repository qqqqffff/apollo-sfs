import Foundation
import PassKit

@objc(RNApplePay)
class RNApplePay: NSObject, PKPaymentAuthorizationControllerDelegate {

  private var resolve: RCTPromiseResolveBlock?
  private var reject: RCTPromiseRejectBlock?
  private var controller: PKPaymentAuthorizationController?
  private var didAuthorize = false

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
    self.resolve = resolve
    self.reject = reject
    self.didAuthorize = false

    let request = PKPaymentRequest()
    request.merchantIdentifier = merchantIdentifier
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

    if let data = try? JSONSerialization.data(withJSONObject: tokenDict),
       let str = String(data: data, encoding: .utf8) {
      self.resolve?(str)
    } else {
      self.reject?("PARSE_ERROR", "Failed to encode Apple Pay token", nil)
    }
    self.resolve = nil
    self.reject = nil

    completion(PKPaymentAuthorizationResult(status: .success, errors: nil))
  }

  func paymentAuthorizationControllerDidFinish(_ controller: PKPaymentAuthorizationController) {
    controller.dismiss(completion: nil)
    self.controller = nil
    if !self.didAuthorize {
      self.reject?("CANCELLED", "User cancelled Apple Pay", nil)
      self.resolve = nil
      self.reject = nil
    }
  }
}
