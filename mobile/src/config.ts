export const API_BASE_URL = 'https://apollo-sfs.com';
export const GOOGLE_IOS_CLIENT_ID = '550302272436-s70nkrvs7263fl3nda5iqqb1s0929o8c.apps.googleusercontent.com';
export const GOOGLE_CLIENT_ID = '550302272436-0l08i22en4eifho0msrr07lkqr0t5ouj.apps.googleusercontent.com';

// ── Keycloak OIDC (mobile public client) ───────────────────────────────────
// Social login uses Keycloak identity-provider brokering: the app runs a
// browser-based Authorization Code + PKCE flow against Keycloak with
// kc_idp_hint=google/apple, and Keycloak returns realm tokens directly (no
// backend token exchange). See keycloak/import/realm.json → apollo-sfs-mobile.
export const KEYCLOAK_ISSUER = 'https://auth.apollo-sfs.com/realms/apollo-sfs-realm';
export const KEYCLOAK_MOBILE_CLIENT_ID = 'apollo-sfs-mobile';
export const OAUTH_REDIRECT_URL = 'apollosfs://oauthredirect';

// Payments — replace with real values before release
export const APPLE_PAY_MERCHANT_ID = 'merchant.com.apollosfs';
export const PAYPAL_MERCHANT_ID = 'HH4449WYNCH5C';
export const PAYPAL_CLIENT_ID = 'AZpc08OnDRkmRw7pbESv98g_Lglv65nMncjLck1eS782ZBxOrOteiMPWGdK4mSjUBfTX7xXeJXpQSwr8';