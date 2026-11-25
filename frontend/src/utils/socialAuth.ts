export type SocialProvider = 'google' | 'apple' | 'microsoft'

// Social sign-in starts at our own API, not at Keycloak. GET /auth/social/start
// 302s the browser into Keycloak's brokered flow (kc_idp_hint, so Keycloak
// forwards straight to the provider instead of rendering its own login page).
//
// Building that URL server-side keeps Keycloak's hostname, realm, client id and
// — most importantly — the redirect_uri out of the bundle, so the only address
// a user ever sees us send them to is this origin. See
// api/routes/auth/social_start.go.
const SOCIAL_START = '/api/v1/auth/social/start'

// Sign-in: the callback stores the resulting tokens as the session.
export function socialLoginUrl(provider: SocialProvider) {
  return `${SOCIAL_START}?provider=${provider}`
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
// carry the cookie. mode=link is what selects that redirect target; the path
// itself lives in linkRedirectPath (api/routes/auth/social_start.go).
export const SOCIAL_LINK_REDIRECT_PATH = '/client/profile'

export function socialLinkUrl(provider: SocialProvider) {
  return `${SOCIAL_START}?provider=${provider}&mode=link`
}
