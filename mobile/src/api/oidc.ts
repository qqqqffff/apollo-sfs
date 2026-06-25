import {
  authorize,
  refresh,
  type AuthConfiguration,
  type AuthorizeResult,
  type RefreshResult,
} from 'react-native-app-auth';
import { KEYCLOAK_ISSUER, KEYCLOAK_MOBILE_CLIENT_ID, OAUTH_REDIRECT_URL } from '../config';

export type IdpHint = 'google' | 'apple';

// Public client config for the browser-based Authorization Code + PKCE flow.
// No client secret — PKCE protects the exchange. See keycloak/import/realm.json
// → apollo-sfs-mobile.
const config: AuthConfiguration = {
  issuer: KEYCLOAK_ISSUER,
  clientId: KEYCLOAK_MOBILE_CLIENT_ID,
  redirectUrl: OAUTH_REDIRECT_URL,
  // openid → id token; profile/email → user claims; offline_access → refresh token.
  scopes: ['openid', 'profile', 'email', 'offline_access'],
};

// Runs the login flow against Keycloak, jumping straight to the given identity
// provider via kc_idp_hint so the user lands on Google/Apple instead of the
// Keycloak username/password page.
//
// prompt=login forces Keycloak to re-authenticate rather than silently reusing an
// existing SSO session, and iosPrefersEphemeralSession stops the system browser
// from carrying over Keycloak/Google/Apple cookies between runs. Without these,
// "Sign in with X" reuses Keycloak's session and skips the provider entirely —
// even after the app has signed out or the account was unlinked.
export function brokerAuthorize(idp: IdpHint): Promise<AuthorizeResult> {
  return authorize({
    ...config,
    additionalParameters: { kc_idp_hint: idp, prompt: 'login' },
    iosPrefersEphemeralSession: true,
    androidPrefersEphemeralSession: true,
  });
}

// Refreshes a brokered token pair directly against Keycloak. The backend cannot
// refresh these: they belong to the public apollo-sfs-mobile client, not the
// confidential apollo-sfs-api client the backend authenticates as.
export function brokerRefresh(refreshToken: string): Promise<RefreshResult> {
  return refresh(config, { refreshToken });
}
