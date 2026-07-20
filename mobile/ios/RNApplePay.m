#import <React/RCTBridgeModule.h>

RCT_EXTERN_MODULE(RNApplePay, NSObject)

RCT_EXTERN_METHOD(
  canMakePayments:(RCTPromiseResolveBlock)resolve
  reject:(RCTPromiseRejectBlock)reject
)

RCT_EXTERN_METHOD(
  requestPayment:(NSString *)amount
  currencyCode:(NSString *)currencyCode
  merchantIdentifier:(NSString *)merchantIdentifier
  label:(NSString *)label
  resolve:(RCTPromiseResolveBlock)resolve
  reject:(RCTPromiseRejectBlock)reject
)

RCT_EXTERN_METHOD(
  completePayment:(BOOL)success
  resolve:(RCTPromiseResolveBlock)resolve
  reject:(RCTPromiseRejectBlock)reject
)
