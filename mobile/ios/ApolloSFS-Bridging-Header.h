//
//  Use this file to import your target's public headers that you would like to expose to Swift.
//

#import <React/RCTBridgeModule.h>

// react-native-app-auth: exposes the RNAppAuthAuthorizationFlowManager protocol
// to Swift. Imported here (not via a Swift `import`) because Pods are static-
// linked, so the Obj-C pod has no Swift module. NOTE: in v8 the pod is named
// `react-native-app-auth` (not the old `RNAppAuth`), so the public-header path
// uses that name.
#import <react-native-app-auth/RNAppAuthAuthorizationFlowManager.h>

