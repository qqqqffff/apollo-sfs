# Mobile App Setup, Testing & Deployment

This guide covers everything from the `mobile/` source code to a working app on a physical device and, finally, to production releases on the App Store and Google Play. The app uses React Native CLI (bare workflow) — no Expo runtime is involved.

---

## Prerequisites

| Tool | Where to get it | Notes |
|------|----------------|-------|
| Node.js 20+ | [nodejs.org](https://nodejs.org) | Required for Metro bundler |
| Watchman | `brew install watchman` | File watcher used by Metro on macOS |
| Ruby 3+ | System or `rbenv` | Required for CocoaPods |
| CocoaPods | `gem install cocoapods` | iOS dependency manager |
| Xcode 15+ | Mac App Store | iOS builds and Simulator; Mac required |
| Android Studio | [developer.android.com](https://developer.android.com/studio) | Android Emulator and SDK tools |
| JDK 17 | `brew install openjdk@17` | Android build toolchain |
| Apple Developer account | [developer.apple.com](https://developer.apple.com) | $99/yr; required to sign iOS builds |
| Google Play Console account | [play.google.com/console](https://play.google.com/console) | One-time $25 fee; required to publish Android |

Follow the [React Native environment setup guide](https://reactnative.dev/docs/set-up-your-environment) for your OS before proceeding.

---

## 1. Create the native project

The `mobile/` directory contains the JavaScript/TypeScript source but not the generated native projects. You need to initialise them once using the React Native CLI:

```bash
npx @react-native-community/cli init ApolloSFS --directory mobile --skip-install
```

> If `mobile/` already exists (which it does after cloning this repo), run the command outside the repo and then copy the generated `android/` and `ios/` directories into `mobile/`. Alternatively, create them with:

```bash
cd mobile
npx react-native build-android  # generates android/ skeleton
npx react-native build-ios      # generates ios/ skeleton (runs pod install)
```

### 1a. Install JS dependencies

```bash
cd mobile
npm install
```

### 1b. Install iOS native dependencies

```bash
cd mobile/ios
pod install
cd ..
```

---

## 2. Native project configuration

These changes must be made in the generated `ios/` and `android/` directories.

### 2a. Fill in the Google OAuth Client ID

Open `mobile/src/config.ts` and replace `REPLACE_WITH_GOOGLE_CLIENT_ID` with the OAuth 2.0 Client ID you created in the [Google Cloud Console](https://console.cloud.google.com) (Application type: **iOS** for the iOS app, **Android** for the Android app):

```ts
export const GOOGLE_CLIENT_ID = 'YOUR_CLIENT_ID.apps.googleusercontent.com';
```

### 2b. iOS — Info.plist

Open `ios/ApolloSFS/Info.plist` and add:

```xml
<!-- Photo library access -->
<key>NSPhotoLibraryUsageDescription</key>
<string>Back up your photos and videos to Apollo SFS.</string>
<key>NSPhotoLibraryAddUsageDescription</key>
<string>Save downloaded files to your photo library.</string>

<!-- Background fetch -->
<key>UIBackgroundModes</key>
<array>
  <string>fetch</string>
  <string>processing</string>
</array>
```

### 2c. iOS — Bundle identifier and Associated Domains

1. Open `ios/ApolloSFS.xcworkspace` in Xcode.
2. Select the **ApolloSFS** target → **Signing & Capabilities**.
3. Set **Bundle Identifier** to `com.apollosfs.app`.
4. Add capability: **Associated Domains** → add `applinks:apollo-sfs.com`.
5. Add capability: **Sign In with Apple**.

### 2d. iOS — URL scheme for deep links

In Xcode, select the **ApolloSFS** target → **Info** → **URL Types** → click **+**:

| Field | Value |
|-------|-------|
| Identifier | `com.apollosfs.app` |
| URL Schemes | `apollosfs` |

This registers `apollosfs://` so navigation deep links work in development.

### 2e. Android — AndroidManifest.xml

Open `android/app/src/main/AndroidManifest.xml` and add the following inside `<manifest>`:

```xml
<!-- Permissions -->
<uses-permission android:name="android.permission.READ_MEDIA_IMAGES" />
<uses-permission android:name="android.permission.READ_MEDIA_VIDEO" />
<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE"
    android:maxSdkVersion="32" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />
<uses-permission android:name="android.permission.INTERNET" />
```

Inside the `<activity>` element for `MainActivity`, add an intent filter for App Links and the custom scheme:

```xml
<!-- Custom scheme -->
<intent-filter>
  <action android:name="android.intent.action.VIEW" />
  <category android:name="android.intent.category.DEFAULT" />
  <category android:name="android.intent.category.BROWSABLE" />
  <data android:scheme="apollosfs" />
</intent-filter>

<!-- Universal App Links (https://apollo-sfs.com/register) -->
<intent-filter android:autoVerify="true">
  <action android:name="android.intent.action.VIEW" />
  <category android:name="android.intent.category.DEFAULT" />
  <category android:name="android.intent.category.BROWSABLE" />
  <data
    android:scheme="https"
    android:host="apollo-sfs.com"
    android:pathPrefix="/register" />
</intent-filter>
```

### 2f. Android — google-services.json

Download `google-services.json` from the [Firebase Console](https://console.firebase.google.com) (or from the [Google Cloud Console](https://console.cloud.google.com) → your project → Android app credentials) and place it at:

```
android/app/google-services.json
```

Add the Google Services plugin to `android/build.gradle`:

```groovy
buildscript {
  dependencies {
    classpath 'com.google.gms:google-services:4.4.2'
  }
}
```

And to `android/app/build.gradle`:

```groovy
apply plugin: 'com.google.gms.google-services'
```

### 2g. Update production domain

If your production domain is not `apollo-sfs.com`, replace every occurrence in:

- `mobile/src/config.ts` — `API_BASE_URL`
- `ios/ApolloSFS/ApolloSFS.entitlements` — `applinks:` entry
- `android/app/src/main/AndroidManifest.xml` — the App Links `android:host`
- `nginx/well-known/.well-known/apple-app-site-association` — `appID` field
- `nginx/well-known/.well-known/assetlinks.json` — as described in section 6

---

## 3. Running on a device or simulator

### 3a. iOS Simulator

```bash
cd mobile
npx react-native run-ios
```

This compiles the app with Xcode and launches it in the default Simulator. To target a specific device:

```bash
npx react-native run-ios --simulator "iPhone 16 Pro"
```

### 3b. iOS physical device

1. Connect your iPhone via USB.
2. In Xcode (**Signing & Capabilities**), select your Apple Developer team so Xcode can sign the build automatically.
3. Run:

```bash
npx react-native run-ios --device "Your iPhone Name"
```

Or build and install directly from Xcode: **Product → Run** with your device selected.

### 3c. Android Emulator

Start an AVD from Android Studio (**Device Manager** → play button), then:

```bash
cd mobile
npx react-native run-android
```

### 3d. Android physical device

Enable **Developer options** and **USB debugging** on your device, connect via USB, then run the same command as above. The CLI auto-detects the connected device.

---

## 4. Testing Sign in with Apple

Sign in with Apple only works on a real iOS device and only when the app is signed with an App ID that has the **Sign In with Apple** capability enabled (already set in step 2c).

### 4a. Enable the capability in your Apple Developer account

1. Go to [developer.apple.com](https://developer.apple.com) → **Certificates, Identifiers & Profiles** → **Identifiers**.
2. Find `com.apollosfs.app` (create it if it doesn't exist).
3. Under **Capabilities**, enable **Sign In with Apple** → Save.

### 4b. Enable Keycloak Apple IdP

Follow the steps in `keycloak/KC_setup.md` under **Apple Identity Provider**. You will need:
- A **Services ID** (e.g. `com.apollosfs.app.signin`) registered in your Apple Developer account with a redirect URI pointing to your Keycloak instance.
- A **Key** with Sign In with Apple enabled; download the `.p8` file.

### 4c. Test flow

1. Build and install on a physical iPhone (`npx react-native run-ios --device`).
2. Tap **Sign in with Apple** on the Login or Register screen.
3. Authenticate with Face ID / Touch ID.
4. The app calls `POST /api/v1/mobile/auth/apple` → Keycloak exchanges the token → app stores tokens and navigates to Home.

---

## 5. Testing the deep-link registration flow

Invitation emails contain a URL like `https://apollo-sfs.com/register?token=abc123`. When the app is installed, iOS/Android should intercept this URL and open the Register screen with the token pre-filled.

### 5a. Custom scheme test (development)

```bash
# iOS Simulator
xcrun simctl openurl booted "apollosfs://register?token=testtoken"

# Android Emulator
adb shell am start -W -a android.intent.action.VIEW \
  -d "apollosfs://register?token=testtoken" com.apollosfs.app
```

### 5b. Enabling Universal Links on iOS (production)

Universal Links require the `apple-app-site-association` file to be served from your domain **before** iOS will intercept the URL. The file is at `nginx/well-known/.well-known/apple-app-site-association`. Update it with your real Team ID and bundle ID:

```json
{
  "applinks": {
    "apps": [],
    "details": [
      {
        "appID": "YOURTEAMID.com.apollosfs.app",
        "paths": ["/register", "/register/*"]
      }
    ]
  }
}
```

Find your Team ID at [developer.apple.com](https://developer.apple.com) → Membership → Team ID.

Verify it is served correctly (no redirect, `Content-Type: application/json`):

```bash
curl -I https://apollo-sfs.com/.well-known/apple-app-site-association
```

### 5c. Enabling App Links on Android (production)

1. Get the SHA-256 fingerprint of your release signing keystore:

```bash
keytool -list -v -keystore android/app/release.keystore -alias your-alias | grep SHA256
```

2. Edit `nginx/well-known/.well-known/assetlinks.json`:

```json
[
  {
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "com.apollosfs.app",
      "sha256_cert_fingerprints": [
        "AB:CD:EF:..."
      ]
    }
  }
]
```

3. Verify with Google's tool:

```
https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://apollo-sfs.com&relation=delegate_permission/common.handle_all_urls
```

---

## 6. Camera roll backup — end-to-end test

1. Install the app on a device and sign in.
2. Open the **Home** screen — tap **Sync Now**.
3. Grant photo library access when prompted.
4. Watch the Metro bundler terminal — you should see upload requests to `/api/v1/files/upload`.
5. Open the **Files** screen — photos should appear.
6. Take a new photo on the device, wait ~30 seconds, tap **Sync Now** again — the new photo should appear.

**Wi-Fi only mode:** Toggle it on in the Settings screen, switch to mobile data, tap **Sync Now** — nothing should upload.

**Dedup:** Upload a photo, delete it from the Files screen, then sync again. The app calls `POST /api/v1/sync/check-hash`; since the file was deleted the hash is gone, so it re-uploads. If you upload the same photo twice *without* deleting it, the second call returns `exists: true` and no upload is performed.

---

## 7. Production build — App Store (iOS)

### 7a. Set the version and build number

In Xcode, select the **ApolloSFS** target → **General** → increment **Version** and **Build** as needed.

### 7b. Create an Archive

In Xcode, select **Any iOS Device (arm64)** as the build target, then:

**Product → Archive**

This builds a release `.xcarchive` in Xcode's Organizer.

### 7c. Upload to App Store Connect

In the Xcode Organizer:

1. Select the archive → **Distribute App**.
2. Choose **App Store Connect** → **Upload**.
3. Follow the prompts; Xcode signs the `.ipa` with your Distribution certificate automatically.

### 7d. Complete the App Store listing

1. Log in to [appstoreconnect.apple.com](https://appstoreconnect.apple.com).
2. Select **My Apps** → **Apollo SFS**.
3. Fill in the required fields:
   - **App name, subtitle, description, keywords**
   - **Screenshots** — at minimum 6.5" iPhone (Simulator: `⌘S` captures a screenshot)
   - **Privacy policy URL** — required for all apps
   - **Age rating** — complete the questionnaire
   - **App Review information** — provide a demo account the Apple reviewer can use
4. Submit for review.

First reviews typically take 1–3 days.

### 7e. App Store capability checklist

Before submitting, confirm the following:

- [ ] **Sign In with Apple** enabled on the App ID
- [ ] **Associated Domains** entitlement enabled (`applinks:apollo-sfs.com`)
- [ ] `UIBackgroundModes` includes `fetch` and `processing` in Info.plist
- [ ] `NSPhotoLibraryUsageDescription` present in Info.plist
- [ ] Distribution certificate and provisioning profile valid in Xcode

---

## 8. Production build — Google Play (Android)

### 8a. Generate a release keystore (first time only)

```bash
keytool -genkey -v -keystore android/app/release.keystore \
  -alias apollosfs -keyalg RSA -keysize 2048 -validity 10000
```

Store this file and its passwords securely — you cannot change it after publishing.

### 8b. Configure signing in Gradle

In `android/app/build.gradle`:

```groovy
android {
  signingConfigs {
    release {
      storeFile file('release.keystore')
      storePassword System.getenv('KEYSTORE_PASS')
      keyAlias 'apollosfs'
      keyPassword System.getenv('KEY_PASS')
    }
  }
  buildTypes {
    release {
      signingConfig signingConfigs.release
      minifyEnabled true
      proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
    }
  }
}
```

### 8c. Build the release AAB

```bash
cd mobile
npx react-native build-android --mode=release
# or
cd android && ./gradlew bundleRelease
```

The signed `.aab` is at `android/app/build/outputs/bundle/release/app-release.aab`.

### 8d. First upload (manual — required for the initial release)

Google requires the first build to be uploaded manually:

1. Go to [play.google.com/console](https://play.google.com/console) → **Create app**.
2. Fill in the app details (name, category, contact email, privacy policy).
3. Navigate to **Testing** → **Internal testing** → **Create new release**.
4. Upload the `.aab` file.
5. Promote to **Closed testing** (alpha) → **Open testing** (beta) → **Production** when ready.

### 8e. Subsequent releases

Build a new AAB, then upload it in the Play Console to the appropriate track.

### 8f. Google Play checklist

- [ ] Target SDK 34+ (set in `android/app/build.gradle`)
- [ ] `READ_MEDIA_IMAGES` and `READ_MEDIA_VIDEO` permissions declared in AndroidManifest.xml
- [ ] Privacy policy URL provided in the Play Console
- [ ] Data safety form completed (the app collects: photos/videos, account info; data is encrypted in transit and at rest)
- [ ] SHA-256 fingerprint from `release.keystore` added to `assetlinks.json` (see section 5c)

---

## 9. Troubleshooting

### Metro bundler: "Unable to resolve module"

```bash
cd mobile
npm install
cd ios && pod install && cd ..
npx react-native start --reset-cache
```

### CocoaPods install fails

```bash
sudo gem install cocoapods
cd mobile/ios
pod repo update
pod install
```

### Sign In with Apple button not appearing

`@invertase/react-native-apple-authentication` only renders the button on iOS. On Android the button is conditionally hidden (`Platform.OS === 'ios'`). On the iOS Simulator the button renders but the authentication sheet fails — test on a real device.

### Universal Links not intercepting (iOS)

- The AASA file must be served without a redirect and with `Content-Type: application/json`. Check the nginx `alias` block in `nginx/conf.d/apollo-sfs.conf`.
- iOS caches the AASA aggressively. After updating the file, test on a fresh device or use the **Associated Domains Development** environment in Xcode (Signing & Capabilities → Associated Domains → tick "Alternate Mode").
- Universal Links require the app to be installed via TestFlight or the App Store (or a development build with the correct entitlement signed by your team).

### Background sync not firing (iOS)

iOS decides when to run background fetch based on battery, network, and usage patterns. During development, trigger it manually from Xcode:

```
Xcode → Debug menu → Simulate Background Fetch
```

Or from the terminal while the Simulator is running:

```bash
xcrun simctl spawn booted backgroundfetch com.apollosfs.app
```

### Android: "react-native-sqlite-storage" build error

Ensure `android/app/build.gradle` targets `minSdkVersion 24` and `compileSdkVersion 34`:

```groovy
android {
  compileSdk 34
  defaultConfig {
    minSdkVersion 24
    targetSdkVersion 34
  }
}
```

### Google Sign-In: "DEVELOPER_ERROR" on Android

This means the SHA-1 fingerprint in your Firebase/Google Cloud project does not match your build's signing certificate. Add the debug fingerprint:

```bash
cd android && ./gradlew signingReport
# Copy the SHA-1 under "Variant: debug" and add it in the Google Cloud Console
# under your Android OAuth 2.0 client → SHA-1 certificate fingerprints
```
