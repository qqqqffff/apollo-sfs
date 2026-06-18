// Type declarations for the Sign in with Apple JS SDK
// https://developer.apple.com/documentation/sign_in_with_apple/sign_in_with_apple_js

interface AppleIDAuthConfig {
  clientId: string
  scope: string
  redirectURI: string
  state?: string
  nonce?: string
  usePopup?: boolean
}

interface AppleIDAuthorizationResponse {
  authorization: {
    code: string
    id_token: string
    state?: string
  }
  /** Only present on the very first sign-in for a given user. */
  user?: {
    email?: string
    name?: {
      firstName?: string
      lastName?: string
    }
  }
}

interface AppleIDAuth {
  init(config: AppleIDAuthConfig): void
  signIn(): Promise<AppleIDAuthorizationResponse>
}

interface Window {
  AppleID?: {
    auth: AppleIDAuth
  }
}
