import { get, post } from './client'

export interface LoginResponse {
  username: string
}

export interface RegisterResponse {
  username: string
}

export function login(username: string, password: string) {
  return post<LoginResponse>('/auth/login', { username, password })
}

export function register(
  username: string,
  email: string,
  password: string,
  invite_token: string,
  captcha_token: string,
) {
  return post<RegisterResponse>('/auth/register', { username, email, password, invite_token, captcha_token })
}

// registerWithReservation registers via a group-registration slot reservation
// (see /group-invite) instead of an admin invitation — the email is
// user-supplied rather than locked to an invite.
export function registerWithReservation(
  username: string,
  email: string,
  password: string,
  reservation_token: string,
  captcha_token: string,
) {
  return post<RegisterResponse>('/auth/register', { username, email, password, reservation_token, captcha_token })
}

export function logout() {
  return post<void>('/auth/logout')
}

export function refresh() {
  return post<void>('/auth/refresh')
}

export function forgotPassword(email: string) {
  return post<{ message: string }>('/auth/forgot_password', { email })
}

export function resetPassword(token: string, new_password: string) {
  return post<{ message: string }>('/auth/reset_password', { token, new_password })
}

export interface InviteValidation {
  email: string
  invited_by_user_id: string
  expires_at: string
  grant_admin: boolean
}

export function validateInviteToken(token: string) {
  return get<InviteValidation>(`/invitations/${token}`)
}
