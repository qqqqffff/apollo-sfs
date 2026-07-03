# Mobile App (iOS + Android)

React Native 0.86 + TypeScript application targeting both iOS and Android from a shared codebase. Authentication is handled via OIDC (Keycloak) with native Apple and Google Sign In flows. Files are synced and stored locally with SQLite for offline-first support.

## Stack

| Concern | Library |
|---------|---------|
| Framework | React Native 0.86 + TypeScript |
| Navigation | `@react-navigation/*` (stack, bottom-tabs) |
| OIDC auth | `react-native-app-auth` 8.0 |
| Apple Sign In | `@invertase/react-native-apple-authentication` 2.4 |
| Google Sign In | `@react-native-google-signin/google-signin` 16.1 |
| Push notifications | `@notifee/react-native` 9.1 |
| File uploads/downloads | `react-native-blob-util` 0.19 |
| Document picker | `react-native-document-picker` 9.3 |
| Photo library | `@react-native-camera-roll/camera-roll` 7.8 |
| Secure credentials | `react-native-encrypted-storage` 4.0 |
| Offline database | `react-native-sqlite-storage` 6.0 |
| HTTP client | `axios` 1.7 |
| Bundler | Metro |
| Tests | Jest + `jest.setup.ts` |

## Directory Structure

```
mobile/
├── App.tsx                 # Root component, navigation container, auth check
├── index.js                # React Native entry point (registers App)
├── app.json                # Expo/RN app config (bundle IDs, version, permissions)
├── src/
│   ├── config.ts           # API base URL, Keycloak config, feature flags
│   ├── theme.ts            # Color palette, spacing, typography
│   ├── navigation/         # Stack and tab navigator definitions
│   ├── screens/            # Screen components (~11 screens)
│   ├── components/         # Shared UI components
│   ├── services/           # Business logic (auth, file sync, push notifications)
│   ├── api/                # Axios client, typed endpoint wrappers
│   ├── context/            # React Context providers (auth, sync state)
│   ├── tasks/              # Background task handlers
│   ├── utils/              # Utility functions
│   └── assets/             # Images, fonts, icons
├── android/                # Android native project (Gradle)
├── ios/                    # iOS native project (Xcode)
├── package.json
├── metro.config.js         # Metro bundler config
├── babel.config.js         # Babel transpiler config
├── tsconfig.json
├── jest.config.js
└── jest.setup.ts
```

## Authentication Flow

The app uses OIDC Authorization Code + PKCE (`react-native-app-auth`) against the `apollo-sfs-mobile` Keycloak client.

### Standard Login
1. `react-native-app-auth` opens a secure browser (ASWebAuthenticationSession on iOS, Chrome Custom Tabs on Android)
2. User authenticates on the hosted Keycloak login page
3. Authorization code is exchanged for access + refresh tokens
4. Tokens are stored in `react-native-encrypted-storage` (hardware-backed keystore on Android, Keychain on iOS)

### Apple Sign In (iOS only)
1. Native `@invertase/react-native-apple-authentication` calls `appleAuth.performRequest`
2. The identity token is sent to the Go API's social auth endpoint
3. The API forwards it to Keycloak's Apple IdP broker
4. Keycloak issues an access token linked to the Apple account

### Google Sign In (iOS + Android)
1. Native `@react-native-google-signin/google-signin` calls `GoogleSignin.signIn()`
2. The ID token is sent to the Go API's social auth endpoint
3. The API forwards it to Keycloak's Google IdP broker
4. Keycloak issues an access token linked to the Google account

### Token Storage
- Access and refresh tokens: `react-native-encrypted-storage`
- Never stored in AsyncStorage (plaintext)
- Refresh is handled transparently by the Axios interceptor in `src/api/`

## Offline Sync

SQLite (`react-native-sqlite-storage`) maintains a local copy of the user's file and folder metadata. The sync endpoint (`GET /api/v1/sync`) returns a diff of changes since the last sync timestamp. Background tasks in `src/tasks/` reconcile local state with server state.

## File Operations

- **Upload:** `react-native-blob-util` streams files to the Go API's upload endpoint. Progress is reported back to the UI via a callback.
- **Download:** Files are streamed to the app's documents directory. The API serves encrypted blobs; decryption happens server-side and the API streams plaintext to the client over HTTPS.
- **Photo library access:** `@react-native-camera-roll/camera-roll` reads the device photo library for upload. Requires `NSPhotoLibraryUsageDescription` (iOS) and `READ_EXTERNAL_STORAGE` (Android < 13) / `READ_MEDIA_IMAGES` (Android 13+).
- **Document picker:** `react-native-document-picker` provides a native file picker for uploads from cloud storage (iCloud, Google Drive, etc.).

## Push Notifications

`@notifee/react-native` handles local and remote push notifications. Remote notifications are sent from the Go API (quota warnings, sync completion, shared file alerts). Both APNs (iOS) and FCM (Android) are supported.

Required setup:
- iOS: APNs key uploaded to the Go API config
- Android: `google-services.json` in `android/app/`

## Deep Linking

Universal Links (iOS) and App Links (Android) are configured in `app.json`. The nginx host serves the required well-known files:

- iOS: `/.well-known/apple-app-site-association`
- Android: `/.well-known/assetlinks.json`

These files live in `nginx/well-known/` and are served directly by host nginx (not proxied to Docker).

## iOS-Specific Setup

1. **Bundle ID:** Set in `ios/<AppName>/Info.plist` and Xcode project settings
2. **Team ID / Signing:** Configure in Xcode under Signing & Capabilities
3. **Capabilities required:**
   - Sign in with Apple
   - Push Notifications (APNs)
   - Associated Domains (`applinks:apollo-sfs.com`)
4. **App.json:** `ios.bundleIdentifier` must match the Apple Developer portal
5. **Pods:** After installing new native modules run `cd ios && pod install`

## Android-Specific Setup

1. **Application ID:** `android/app/build.gradle` → `applicationId`
2. **google-services.json:** Place in `android/app/` (from Firebase console) for FCM
3. **Keystore:** Production builds require a signing keystore; configure in `android/app/build.gradle` or via env vars
4. **Permissions declared in `AndroidManifest.xml`:** `INTERNET`, `READ_MEDIA_IMAGES`, `CAMERA`, `RECEIVE_BOOT_COMPLETED` (background tasks)

## Building

```bash
# Install dependencies
cd mobile
npm ci
cd ios && pod install && cd ..

# iOS (simulator)
npx react-native run-ios

# iOS (device / release)
npx react-native run-ios --configuration Release --device "<device name>"

# Android (emulator)
npx react-native run-android

# Android (release APK)
cd android && ./gradlew assembleRelease

# Android (release AAB for Play Store)
cd android && ./gradlew bundleRelease
```

## Testing

```bash
npm test                  # Jest unit tests
npm run test -- --watch   # Watch mode
```

`jest.setup.ts` mocks native modules that require a device/simulator (camera roll, encrypted storage, SQLite).

## Key Configuration (`src/config.ts`)

| Key | Purpose |
|-----|---------|
| `API_BASE_URL` | Go API base URL (`https://apollo-sfs.com/api/v1`) |
| `KEYCLOAK_URL` | Keycloak public URL (`https://auth.apollo-sfs.com`) |
| `KEYCLOAK_REALM` | Realm name (`apollo-sfs-realm`) |
| `KEYCLOAK_CLIENT_ID` | Mobile client ID (`apollo-sfs-mobile`) |
| `GOOGLE_WEB_CLIENT_ID` | Google Sign In web client ID (for token exchange) |
| `APPLE_SERVICE_ID` | Apple Services ID (`com.apollorowe.apollosfs.signin`) |

## Metro Bundler

`metro.config.js` extends the default config. If you add new file types or asset extensions, update the `resolver.assetExts` or `resolver.sourceExts` arrays here.

## Release Checklist

- [ ] Bump `version` in `package.json` and `app.json`
- [ ] Bump `versionCode` (Android) and `buildNumber` (iOS) in `app.json`
- [ ] Confirm `API_BASE_URL` points to production, not a dev server
- [ ] Verify `google-services.json` is the production Firebase project
- [ ] Run `pod install` after any native dependency changes
- [ ] Test Apple Sign In on a real iOS device (simulator does not support it)
- [ ] Test Google Sign In on a real Android device
- [ ] Verify Universal Links / App Links resolve correctly
- [ ] Submit iOS build via Xcode → Organizer → Distribute App
- [ ] Submit Android AAB via Play Console
