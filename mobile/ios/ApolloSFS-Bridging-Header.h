//
//  Use this file to import your target's public headers that you would like to expose to Swift.
//

#import <React/RCTBridgeModule.h>

// react-native-app-auth: exposes the RNAppAuthAuthorizationFlowManager protocol
// to Swift. Imported here (not via `import RNAppAuth`) because Pods are static-
// linked, so the Obj-C pod has no Swift module — but use_modular_headers! makes
// its headers available with angle-bracket imports.
#import <RNAppAuth/RNAppAuthAuthorizationFlowManager.h>

