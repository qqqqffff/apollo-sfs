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
) {
  return post<RegisterResponse>('/auth/register', { username, email, password, invite_token })
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

export function validateInviteToken(token: string) {
  return get<{ valid: boolean }>(`/invitations/${token}`)
}
