# Mobile App Setup, Testing & Deployment

This guide uses React Native CLI (bare workflow) — no Expo runtime. **Part 1** covers everything you need to build, test, and release the iOS app. **Part 2** covers Android.

---

# Part 1 — iOS

## Prerequisites

| Tool | Where to get it | Notes |
|------|----------------|-------|
| Node.js 20+ | [nodejs.org](https://nodejs.org) | Required for Metro bundler |
| Watchman | `brew install watchman` | File watcher used by Metro on macOS |
| Ruby 3+ | System or `rbenv` | Required for CocoaPods |
| CocoaPods | `gem install cocoapods` | iOS dependency manager |
| Xcode 15+ | Mac App Store | Builds, Simulator, and code signing |
| Apple Developer account | [developer.apple.com](https://developer.apple.com) | $99/yr; required to sign iOS builds |

Follow the [React Native environment setup guide](https://reactnative.dev/docs/set-up-your-environment) for macOS before continuing.

---

## 1. Initial project setup

The `mobile/` directory contains the JS/TS source but not the generated native projects. Initialise them once:

```bash
# Run outside the repo, then copy ios/ into mobile/
npx @react-native-community/cli init ApolloSFS --skip-install
cp -r ApolloSFS/ios /path/to/repo/mobile/ios
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

> **Icons:** The app uses `lucide-react-native` + `react-native-svg` for vector icons. CocoaPods picks up the SVG renderer automatically during `pod install` — no font files to configure.

---

## 2. iOS native configuration

### 2a. Fill in the Google OAuth Client ID

Open `mobile/src/config.ts` and replace `REPLACE_WITH_GOOGLE_CLIENT_ID` with the OAuth 2.0 Client ID you created in the [Google Cloud Console](https://console.cloud.google.com) (Application type: **iOS**):

```ts
export const GOOGLE_CLIENT_ID = 'YOUR_CLIENT_ID.apps.googleusercontent.com';
```

### 2b. Info.plist

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

### 2c. Bundle identifier, Associated Domains, and Sign In with Apple

1. Open `ios/ApolloSFS.xcworkspace` in Xcode.
2. Select the **ApolloSFS** target → **Signing & Capabilities**.
3. Set **Bundle Identifier** to `com.apollorowe.apollosfs`.
4. Select your **Team** (requires Apple Developer account).
5. Add capability: **Associated Domains** → add `applinks:apollo-sfs.com`.
6. Add capability: **Sign In with Apple**.

### 2d. URL scheme for development deep links

In Xcode → target **ApolloSFS** → **Info** → **URL Types** → click **+**:

| Field | Value |
|-------|-------|
| Identifier | `com.apollosfs.app` |
| URL Schemes | `apollosfs` |

This registers `apollosfs://` so deep links work in Simulator and development builds.

### 2e. Update production domain

If your production domain is not `apollo-sfs.com`, replace every occurrence in:

- `mobile/src/config.ts` — `API_BASE_URL`
- `ios/ApolloSFS/ApolloSFS.entitlements` — `applinks:` entry
- `nginx/well-known/.well-known/apple-app-site-association` — `appID` field

---

## 3. Running on iOS

### 3a. Simulator

```bash
cd mobile
npx react-native run-ios
# Target a specific model:
npx react-native run-ios --simulator "iPhone 16 Pro"
```

### 3b. Physical device

1. Connect your iPhone via USB.
2. In Xcode **Signing & Capabilities**, confirm your Developer team is selected.
3. Run:

```bash
npx react-native run-ios --device "Your iPhone Name"
```

Or select your device in Xcode and press **Product → Run**.

---

## 4. Testing Sign in with Apple

Sign in with Apple only works on a real iOS device with an App ID that has the capability enabled.

### 4a. Enable the capability in your Apple Developer account

1. Go to [developer.apple.com](https://developer.apple.com) → **Certificates, Identifiers & Profiles** → **Identifiers**.
2. Find `com.apollosfs.app` (create it if it doesn't exist).
3. Under **Capabilities**, enable **Sign In with Apple** → Save.

### 4b. Enable the Keycloak Apple IdP

Run the Social IdP step in `keycloak/KC_setup.md` (`configure_social_idps`). You will need:

- A **Services ID** (e.g. `com.apollosfs.app.signin`) registered in your Apple Developer account with a redirect URI pointing to your Keycloak instance:
  `https://<your-domain>/realms/filestorage/broker/apple/endpoint`
- A **Key** with Sign In with Apple enabled — download the `.p8` file.

Set the env vars before running the script:

```bash
export APPLE_SERVICES_ID="com.apollosfs.app.signin"
export APPLE_TEAM_ID="ABCDE12345"
export APPLE_KEY_ID="XXXXXXXXXX"
export APPLE_P8_PATH="/path/to/AuthKey_XXXXXXXXXX.p8"
```

### 4c. Test flow

1. Install a development build on a physical iPhone.
2. Tap **Sign in with Apple** on the Login or Register screen.
3. Authenticate with Face ID / Touch ID.
4. The app calls `POST /api/v1/mobile/auth/apple` → Keycloak exchanges the token → app stores tokens and navigates to Home.

---

## 5. Testing deep links on iOS

Invitation emails contain a URL like `https://apollo-sfs.com/register?token=abc123`. When the app is installed, iOS should intercept it and open the Register screen with the token pre-filled.

### 5a. Development test (custom scheme)

```bash
# Simulator
xcrun simctl openurl booted "apollosfs://register?token=testtoken"

# Physical device — triggers the app if it is in the foreground or background
xcrun devicectl device process launch --device <device-udid> \
  com.apollosfs.app --url "apollosfs://register?token=testtoken"
```

### 5b. Universal Links (production)

Universal Links require the `apple-app-site-association` file to be served from your domain before iOS will intercept HTTPS URLs.

1. Update `nginx/well-known/.well-known/apple-app-site-association` with your Team ID:

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

2. Verify it is served correctly (no redirect, correct Content-Type):

   ```bash
   curl -I https://apollo-sfs.com/.well-known/apple-app-site-association
   # Must return: Content-Type: application/json
   # Must NOT redirect (no 301/302)
   ```

3. On a physical device, open a `https://apollo-sfs.com/register?token=…` link in Safari or Messages — the app should open directly.

> Universal Links activate when the app is installed via TestFlight or the App Store (or a development build signed by your team with the correct entitlement). iOS caches the AASA aggressively — after updating it, use **Alternate Mode** in Xcode (Signing & Capabilities → Associated Domains → tick "Alternate Mode") or test on a fresh device.

---

## 6. Camera roll backup — end-to-end test

1. Install a development build on a device and sign in.
2. Open the **Home** screen → tap **Sync Now**.
3. Grant photo library access when prompted.
4. Watch the Metro terminal — you should see upload requests to `/api/v1/files/upload`.
5. Open the **Files** screen — photos should appear.
6. Take a new photo, wait ~30 seconds, tap **Sync Now** again — the new photo appears.

**Wi-Fi only mode:** Toggle it on in Settings, switch to mobile data, tap **Sync Now** — nothing should upload.

**Dedup check:** Upload a photo, delete it from the Files screen, then sync again. The app calls `POST /api/v1/sync/check-hash`; since the hash is gone it re-uploads. If you sync the same photo twice without deleting it, the second call returns `exists: true` and no re-upload occurs.

**Background sync:** Trigger it manually during development:

```
Xcode → Debug menu → Simulate Background Fetch
```

or from the terminal:

```bash
xcrun simctl spawn booted backgroundfetch com.apollosfs.app
```

---

## 7. Releasing on the App Store

### 7a. Set the version and build number

In Xcode → target **ApolloSFS** → **General** → increment **Version** (e.g. `1.0.0`) and **Build** (integer, must increase for each upload).

### 7b. Create an Archive

Select **Any iOS Device (arm64)** as the run destination, then:

**Product → Archive**

The archive appears in **Window → Organizer**.

### 7c. Upload to App Store Connect

In Xcode Organizer:

1. Select the archive → **Distribute App**.
2. Choose **App Store Connect** → **Upload**.
3. Follow the prompts — Xcode signs the `.ipa` with your Distribution certificate automatically.

### 7d. Complete the App Store listing

1. Log in to [appstoreconnect.apple.com](https://appstoreconnect.apple.com).
2. Select **My Apps** → **Apollo SFS** (create the app if it doesn't exist yet).
3. Fill in all required fields:
   - App name, subtitle, description, keywords
   - **Screenshots** — at minimum 6.5" iPhone (`⌘S` in Simulator captures a screenshot)
   - **Privacy policy URL** — required for all apps
   - **Age rating** — complete the questionnaire
   - **App Review information** — provide a demo account for the Apple reviewer
4. Under **Build**, select the build you just uploaded.
5. Click **Submit for Review**.

First reviews typically take 1–3 days.

### 7e. Pre-submission checklist

- [ ] **Sign In with Apple** capability enabled on the App ID in Apple Developer portal
- [ ] **Associated Domains** entitlement present (`applinks:apollo-sfs.com`)
- [ ] `UIBackgroundModes` contains `fetch` and `processing` in Info.plist
- [ ] `NSPhotoLibraryUsageDescription` present in Info.plist
- [ ] Distribution certificate and provisioning profile valid and selected in Xcode
- [ ] `apple-app-site-association` file serving correctly from your domain
- [ ] Version and build number incremented since last submission

---

# Part 2 — Android

## 8. Additional prerequisites

| Tool | Where to get it | Notes |
|------|----------------|-------|
| Android Studio | [developer.android.com](https://developer.android.com/studio) | Android Emulator and SDK tools |
| JDK 17 | `brew install openjdk@17` | Android build toolchain |
| Google Play Console account | [play.google.com/console](https://play.google.com/console) | One-time $25 fee |

---

## 9. Android native configuration

### 9a. Generate the native project

```bash
# Run outside the repo, then copy android/ into mobile/
npx @react-native-community/cli init ApolloSFS --skip-install
cp -r ApolloSFS/android /path/to/repo/mobile/android
```

### 9b. Fill in the Google OAuth Client ID

In `mobile/src/config.ts`, set the Client ID to the **Android** OAuth 2.0 client from the [Google Cloud Console](https://console.cloud.google.com) (Application type: **Android**):

```ts
export const GOOGLE_CLIENT_ID = 'YOUR_ANDROID_CLIENT_ID.apps.googleusercontent.com';
```

### 9c. AndroidManifest.xml

Open `android/app/src/main/AndroidManifest.xml` and add inside `<manifest>`:

```xml
<uses-permission android:name="android.permission.READ_MEDIA_IMAGES" />
<uses-permission android:name="android.permission.READ_MEDIA_VIDEO" />
<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE"
    android:maxSdkVersion="32" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />
<uses-permission android:name="android.permission.INTERNET" />
```

Inside the `<activity>` element for `MainActivity`, add intent filters for the custom scheme and App Links:

```xml
<!-- Development deep links (apollosfs://) -->
<intent-filter>
  <action android:name="android.intent.action.VIEW" />
  <category android:name="android.intent.category.DEFAULT" />
  <category android:name="android.intent.category.BROWSABLE" />
  <data android:scheme="apollosfs" />
</intent-filter>

<!-- Production App Links (https://apollo-sfs.com/register) -->
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

### 9d. google-services.json

Download `google-services.json` from the [Firebase Console](https://console.firebase.google.com) (or Google Cloud Console → Android app credentials) and place it at:

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

And apply it in `android/app/build.gradle`:

```groovy
apply plugin: 'com.google.gms.google-services'
```

### 9e. Update production domain

If your production domain is not `apollo-sfs.com`, also replace occurrences in:

- `android/app/src/main/AndroidManifest.xml` — the App Links `android:host`
- `nginx/well-known/.well-known/assetlinks.json` — as described in section 11

---

## 10. Running on Android

### 10a. Emulator

Start an AVD from Android Studio (**Device Manager** → play button), then:

```bash
cd mobile
npx react-native run-android
```

### 10b. Physical device

Enable **Developer options** and **USB debugging** on your device, connect via USB, then run the same command — the CLI auto-detects the connected device.

---

## 11. Testing deep links on Android

### 11a. Development test

```bash
adb shell am start -W -a android.intent.action.VIEW \
  -d "apollosfs://register?token=testtoken" com.apollosfs.app
```

### 11b. App Links (production)

1. Get the SHA-256 fingerprint of your release signing keystore:

   ```bash
   keytool -list -v -keystore android/app/release.keystore -alias apollosfs | grep SHA256
   ```

2. Edit `nginx/well-known/.well-known/assetlinks.json`:

   ```json
   [
     {
       "relation": ["delegate_permission/common.handle_all_urls"],
       "target": {
         "namespace": "android_app",
         "package_name": "com.apollosfs.app",
         "sha256_cert_fingerprints": ["AB:CD:EF:..."]
       }
     }
   ]
   ```

3. Verify with Google's tool:

   ```
   https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://apollo-sfs.com&relation=delegate_permission/common.handle_all_urls
   ```

---

## 12. Releasing on Google Play

### 12a. Generate a release keystore (first time only)

```bash
keytool -genkey -v -keystore android/app/release.keystore \
  -alias apollosfs -keyalg RSA -keysize 2048 -validity 10000
```

Store this file and its passwords securely — you cannot change it after publishing.

### 12b. Configure signing in Gradle

In `android/app/build.gradle`:

```groovy
android {
  signingConfigs {
    release {
      storeFile     file('release.keystore')
      storePassword System.getenv('KEYSTORE_PASS')
      keyAlias      'apollosfs'
      keyPassword   System.getenv('KEY_PASS')
    }
  }
  buildTypes {
    release {
      signingConfig   signingConfigs.release
      minifyEnabled   true
      proguardFiles   getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
    }
  }
}
```

### 12c. Build the release AAB

```bash
cd mobile/android
./gradlew bundleRelease
```

The signed `.aab` is at `android/app/build/outputs/bundle/release/app-release.aab`.

### 12d. First upload (manual — required for the initial release)

Google requires the first build to be uploaded manually:

1. Go to [play.google.com/console](https://play.google.com/console) → **Create app**.
2. Fill in the app details (name, category, contact email, privacy policy).
3. Navigate to **Testing** → **Internal testing** → **Create new release**.
4. Upload the `.aab` file.
5. Promote through **Closed testing** (alpha) → **Open testing** (beta) → **Production** when ready.

### 12e. Subsequent releases

Build a new AAB with an incremented `versionCode` in `build.gradle`, then upload it in the Play Console to the target track.

### 12f. Google Play pre-submission checklist

- [ ] `targetSdkVersion 34+` in `android/app/build.gradle`
- [ ] `READ_MEDIA_IMAGES` and `READ_MEDIA_VIDEO` permissions declared in AndroidManifest.xml
- [ ] Privacy policy URL provided in the Play Console
- [ ] Data safety form completed (app collects photos/videos and account info; data is encrypted in transit and at rest)
- [ ] SHA-256 fingerprint from `release.keystore` added to `assetlinks.json` (see section 11b)
- [ ] `google-services.json` present and SHA-1 debug fingerprint added to Google Cloud OAuth client for testing

---

# Troubleshooting

## iOS

### Metro: "Unable to resolve module"

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

### Sign In with Apple button not rendering

The button only renders on iOS (`Platform.OS === 'ios'` guard). On the Simulator the button renders but the authentication sheet fails — test on a real device.

### Universal Links not intercepting

- The AASA file must be served without a redirect and with `Content-Type: application/json`. Check the nginx `alias` block in `nginx/conf.d/apollo-sfs.conf`.
- iOS caches the AASA aggressively — use **Alternate Mode** in Xcode (Signing & Capabilities → Associated Domains → tick "Alternate Mode") while iterating.
- Universal Links only activate for builds installed via TestFlight, the App Store, or a development build signed by your team with the correct entitlement.

### Background sync not firing

iOS schedules background fetch based on battery and usage patterns. Trigger manually:

```
Xcode → Debug menu → Simulate Background Fetch
```

or via terminal:

```bash
xcrun simctl spawn booted backgroundfetch com.apollosfs.app
```

## Android

### `react-native-sqlite-storage` build error

Ensure `android/app/build.gradle` targets at least SDK 24:

```groovy
android {
  compileSdk 34
  defaultConfig {
    minSdkVersion 24
    targetSdkVersion 34
  }
}
```

### Google Sign-In: "DEVELOPER_ERROR"

The SHA-1 fingerprint in your Firebase / Google Cloud project doesn't match the signing certificate. Add the debug fingerprint:

```bash
cd android && ./gradlew signingReport
# Copy the SHA-1 under "Variant: debug" and register it in the Google Cloud Console
# under your Android OAuth 2.0 client → SHA-1 certificate fingerprints
```
