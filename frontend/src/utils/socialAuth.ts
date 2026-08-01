export type SocialProvider = 'google' | 'apple' | 'microsoft'

const KC_REALM = 'apollo-sfs-realm'
const KC_CLIENT_ID = 'apollo-sfs-api'
// Keycloak runs on its own hostname (see nginx auth.apollo-sfs.com vhost). The
// browser is redirected here to start the OIDC code flow; the callback returns
// to this app's own origin (redirect_uri below).
const KC_BASE_URL = 'https://auth.apollo-sfs.com'

function authorizeUrl(provider: SocialProvider, callbackPath: string) {
  const params = new URLSearchParams({
    client_id: KC_CLIENT_ID,
    redirect_uri: `${window.location.origin}${callbackPath}`,
    response_type: 'code',
    scope: 'openid',
    kc_idp_hint: provider,
    // Force re-authentication instead of silently reusing a Keycloak SSO session,
    // so clicking the button always goes through the provider.
    prompt: 'login',
    state: provider, // echoed back by KC so the callback knows which provider returned
  })
  return `${KC_BASE_URL}/realms/${KC_REALM}/protocol/openid-connect/auth?${params}`
}

// Sign-in: the callback stores the resulting tokens as the session.
export function socialLoginUrl(provider: SocialProvider) {
  return authorizeUrl(provider, '/api/v1/auth/social/callback')
}

// Account linking from the profile page: the same brokered flow, except the
// resulting identity is attached to the session that's already signed in rather
// than logging anyone in. The browser has no provider SDK to hand us an ID token
// the way the mobile apps do, so re-running the authorization-code flow is how
// the identity is obtained.
//
// Keycloak redirects back to the profile page itself, not to an API callback:
// the session cookie is SameSite=Strict, so it is not sent on the cross-site
// redirect back from Keycloak and an API callback would arrive unauthenticated.
// The page instead forwards the code over a normal same-site XHR, which does
// carry the cookie. Keep in sync with brokeredLinkRedirectPath in api/routes/me.go.
export const SOCIAL_LINK_REDIRECT_PATH = '/client/profile'

export function socialLinkUrl(provider: SocialProvider) {
  return authorizeUrl(provider, SOCIAL_LINK_REDIRECT_PATH)
}
