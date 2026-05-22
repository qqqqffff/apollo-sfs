# Mobile App Setup, Testing & Deployment

This guide walks through everything you need to go from the `mobile/` source code to a working app on a physical device and, finally, to production releases on the App Store and Google Play.

---

## Prerequisites

| Tool | Where to get it | Notes |
|------|----------------|-------|
| Node.js 20+ | [nodejs.org](https://nodejs.org) | Required for the Expo toolchain |
| Expo CLI | `npm install -g expo-cli eas-cli` | EAS CLI is needed for cloud builds and submissions |
| Xcode 15+ | Mac App Store | iOS builds and Simulator; Mac required |
| Android Studio | [developer.android.com](https://developer.android.com/studio) | Android Emulator and SDK |
| Apple Developer account | [developer.apple.com](https://developer.apple.com) | $99/yr; required to sign iOS builds |
| Google Play Console account | [play.google.com/console](https://play.google.com/console) | One-time $25 fee; required to publish Android |

---

## 1. Initial project setup

```bash
cd mobile
npm install
```

### 1a. Fill in the two placeholder values

Open each of the three screen files below and replace `REPLACE_WITH_GOOGLE_CLIENT_ID` with the OAuth 2.0 Client ID you created in the [Google Cloud Console](https://console.cloud.google.com) (Application type: **Web application**):

```
src/screens/LoginScreen.tsx
src/screens/RegisterScreen.tsx
src/screens/ProfileScreen.tsx
```

### 1b. Update your production domain

If your production domain is not `apollo-sfs.com`, replace every occurrence in:

- `app.json` — `associatedDomains`, `intentFilters.data.host`
- `nginx/well-known/.well-known/apple-app-site-association` — `appID` field
- `nginx/well-known/.well-known/assetlinks.json` — update as described in section 6

---

## 2. Running in the Expo Go app (fastest way to iterate)

Expo Go lets you preview the app on a real device over your local network without installing Xcode or Android Studio.

```bash
cd mobile
npx expo start
```

Scan the QR code shown in the terminal with:
- **iOS** — the Camera app (opens Expo Go automatically)
- **Android** — the Expo Go app from the Play Store

> **Limitation:** `expo-apple-authentication` and background fetch do **not** run inside Expo Go because they require native capabilities. Use a development build (section 3) to test those features.

---

## 3. Development builds (full native capabilities)

A development build is a custom version of the app that includes all native modules and connects to the Expo dev server. It behaves exactly like the final production app except that the JS bundle is served over the network for fast hot-reload.

### 3a. Log in to Expo / EAS

```bash
eas login
```

Create an Expo account at [expo.dev](https://expo.dev) if you don't have one.

### 3b. Configure EAS

```bash
cd mobile
eas build:configure
```

This creates `eas.json`. Accept the defaults; EAS will manage provisioning profiles and signing automatically.

### 3c. Build for iOS (runs on EAS cloud)

```bash
eas build --platform ios --profile development
```

EAS will:
1. Ask you to log in to your Apple Developer account (done once).
2. Create or reuse an App ID for `com.apollosfs.app`.
3. Generate a Development provisioning profile and signing certificate.
4. Build the `.ipa` and give you a QR code to install it on your device via AirDrop or a direct URL.

Install the `.ipa` on your iPhone, then start the Expo dev server:

```bash
npx expo start --dev-client
```

Open the app — it will connect to your local Expo server automatically.

### 3d. Build for Android (runs on EAS cloud)

```bash
eas build --platform android --profile development
```

Install the resulting `.apk` on your Android device (enable "Install from unknown sources" in Settings → Security).

### 3e. Run on iOS Simulator (no Apple account needed)

```bash
npx expo run:ios
```

This compiles the app locally using Xcode and launches it in the Simulator. Requires Xcode 15+ installed and `xcode-select --install` run at least once.

### 3f. Run on Android Emulator

Start an AVD from Android Studio (Device Manager → play button), then:

```bash
npx expo run:android
```

---

## 4. Testing Sign in with Apple

Sign in with Apple only works on a real iOS device (not the Simulator) and only when the app is signed with an App ID that has the **Sign In with Apple** capability enabled.

### 4a. Enable the capability in your Apple Developer account

1. Go to [developer.apple.com/account](https://developer.apple.com/account) → **Certificates, Identifiers & Profiles** → **Identifiers**.
2. Find `com.apollosfs.app` (or create it).
3. Under **Capabilities**, check **Sign In with Apple** → Save.

### 4b. Enable Keycloak Apple IdP

Follow the steps in `keycloak/KC_setup.md` under **Apple Identity Provider**. You will need:
- A **Services ID** (e.g. `com.apollosfs.app.signin`) registered in your Apple Developer account with a redirect URI pointing to your Keycloak instance.
- A **Key** with Sign In with Apple enabled; download the `.p8` file.

Once configured, Keycloak's `/api/v1/mobile/auth/apple` endpoint accepts the `identityToken` the device generates.

### 4c. Test flow

1. Install a development build on a physical iPhone.
2. Tap **Sign in with Apple** on the Login or Register screen.
3. Authenticate with Face ID / Touch ID.
4. The app calls `POST /api/v1/mobile/auth/apple` → your Keycloak instance exchanges the token → app stores the resulting tokens and navigates to the Home screen.

---

## 5. Testing the deep-link registration flow

Invitation emails contain a URL like `https://apollo-sfs.com/register?token=abc123`. When the app is installed, iOS/Android should intercept this URL and open the Register screen with the token pre-filled.

### 5a. Local development test

```bash
npx uri-scheme open "https://apollo-sfs.com/register?token=testtoken" --ios
# or
npx uri-scheme open "https://apollo-sfs.com/register?token=testtoken" --android
```

### 5b. Enabling Universal Links on iOS (production)

Universal Links require the `apple-app-site-association` file to be served from your domain **before** iOS will intercept the URL. The file is already at `nginx/well-known/.well-known/apple-app-site-association`; you need to update it with your real Team ID and bundle ID:

1. Find your **Team ID** at [developer.apple.com/account](https://developer.apple.com/account) → Membership → Team ID (10-character alphanumeric string).

2. Edit `nginx/well-known/.well-known/apple-app-site-association`:

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

3. Verify it is served correctly (no redirect, correct Content-Type):

   ```bash
   curl -I https://apollo-sfs.com/.well-known/apple-app-site-association
   # Must return: Content-Type: application/json
   # Must NOT redirect (no 301/302)
   ```

4. On a physical device, opening a `https://apollo-sfs.com/register?token=…` link in Safari or Messages should now open the Apollo SFS app directly instead of the browser.

### 5c. Enabling App Links on Android (production)

1. Get the SHA-256 fingerprint of your app signing key:

   ```bash
   # If you let EAS manage signing (recommended):
   eas credentials --platform android
   # Copy the SHA-256 fingerprint shown under "Keystore"

   # If using your own keystore:
   keytool -list -v -keystore your-keystore.jks -alias your-alias | grep SHA256
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

1. Install the development build on a device and sign in.
2. Open the **Home** screen — tap **Sync Now**.
3. Grant photo library access when prompted.
4. Watch the terminal (`npx expo start` logs) — you should see upload requests to `/api/v1/files/upload`.
5. Open the **Files** screen — photos should appear.
6. Take a new photo on the device, wait ~30 seconds, tap **Sync Now** again — the new photo should appear.

**Wi-Fi only mode:** Toggle it on in the Settings screen, switch to mobile data, tap **Sync Now** — nothing should upload.

**Dedup:** Upload a photo, delete it from the Files screen, then sync again. The app calls `POST /api/v1/sync/check-hash`; since the file was deleted the hash is gone, so it re-uploads. If you upload the same photo twice *without* deleting it, the second call returns `exists: true` and no upload is performed.

---

## 7. Production build — App Store (iOS)

### 7a. Create the production build

```bash
cd mobile
eas build --platform ios --profile production
```

EAS will create a Distribution provisioning profile and sign the `.ipa` automatically. The build runs in the EAS cloud (~15–20 minutes).

### 7b. Submit to App Store Connect

```bash
eas submit --platform ios
```

EAS uploads the `.ipa` to App Store Connect. You will be prompted for your Apple ID credentials once.

### 7c. Complete the App Store listing

1. Log in to [appstoreconnect.apple.com](https://appstoreconnect.apple.com).
2. Select **My Apps** → **Apollo SFS**.
3. Fill in the required fields:
   - **App name, subtitle, description, keywords**
   - **Screenshots** — at minimum 6.5" iPhone (you can use the Simulator: `⌘S` captures a screenshot)
   - **Privacy policy URL** — required for all apps
   - **Age rating** — complete the questionnaire
   - **App Review information** — provide a demo account the Apple reviewer can use
4. Submit for review.

First reviews typically take 1–3 days.

### 7d. App Store capability checklist

Before submitting, confirm the following are configured in App Store Connect and your Developer account:

- [ ] **Sign In with Apple** enabled on the App ID
- [ ] **Associated Domains** entitlement enabled on the App ID (`applinks:apollo-sfs.com`)
- [ ] Background Modes: **Background fetch** and **Background processing** checked in Xcode capabilities (handled by `app.json` `backgroundModes`)
- [ ] Photo Library usage description present in `app.json` `infoPlist`

---

## 8. Production build — Google Play (Android)

### 8a. Create the production build

```bash
cd mobile
eas build --platform android --profile production
```

This produces a signed `.aab` (Android App Bundle). EAS generates and stores the keystore automatically; you can export it later from `eas credentials`.

### 8b. First upload (manual — required for the initial release)

Google requires the first build to be uploaded manually:

1. Go to [play.google.com/console](https://play.google.com/console) → Create app.
2. Fill in the app details (name, category, contact email, privacy policy).
3. Navigate to **Testing** → **Internal testing** → **Create new release**.
4. Upload the `.aab` file downloaded from EAS.
5. Promote to **Closed testing** (alpha) → **Open testing** (beta) → **Production** when ready.

### 8c. Subsequent releases

```bash
eas submit --platform android
```

EAS uploads the `.aab` directly to the Play Console track you specify.

### 8d. Google Play checklist

- [ ] Target SDK 34+ (Expo 52 handles this automatically)
- [ ] `READ_MEDIA_IMAGES` and `READ_MEDIA_VIDEO` permissions declared (already in `app.json`)
- [ ] Privacy policy URL provided in the Play Console
- [ ] Data safety form completed (the app collects: photos/videos, account info; data is encrypted in transit and at rest)
- [ ] SHA-256 fingerprint from the EAS-managed keystore added to `assetlinks.json` (see section 5c)

---

## 9. Over-the-air updates (JS-only changes)

For changes that don't touch native modules (most UI and logic changes), you can push updates directly to users without going through App Store/Play Store review:

```bash
cd mobile
eas update --branch production --message "Fix sync cursor bug"
```

Users will receive the update silently the next time they open the app. This is handled by Expo Updates (included in Expo 52 by default).

> OTA updates cannot change native code, permissions, or add new native modules. Those always require a new store build.

---

## 10. Troubleshooting

### "Unable to resolve module" on `npx expo start`

```bash
cd mobile
npx expo install --fix   # repairs version mismatches
npm install              # installs any missing packages
```

### Sign In with Apple button not appearing

The `expo-apple-authentication` button only renders on iOS. On Android it is conditionally hidden (`Platform.OS === 'ios'`). On the iOS Simulator the button renders but the authentication sheet will fail — test on a real device.

### Universal Links not intercepting (iOS)

- The AASA file must be served without a redirect and with `Content-Type: application/json`. Check the nginx `alias` block in `nginx/conf.d/apollo-sfs.conf`.
- iOS caches the AASA aggressively. After updating the file, test on a fresh device or use the **Associated Domains Development** environment in Xcode (Signing & Capabilities → Associated Domains → tick "Alternate Mode").
- The app must be installed via TestFlight or the App Store for Universal Links to activate in production. Development builds with the correct entitlement also work.

### Background sync not firing (iOS)

iOS decides when to run background fetch tasks based on battery, network, and usage patterns. During development, trigger it manually:

```
Xcode → Debug menu → Simulate Background Fetch
```

Or from the terminal while the device is connected:

```bash
xcrun simctl spawn booted backgroundfetch com.apollosfs.app
```

### EAS build fails with provisioning error

```bash
eas credentials --platform ios
# Select "Remove" for stale profiles, then re-run eas build
```
