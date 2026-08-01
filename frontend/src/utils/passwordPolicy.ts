// Single source of truth for the password rules shown in the UI. These mirror
// the Keycloak realm policy (`passwordPolicy` in keycloak/import/realm.json):
//
//   length(12) and upperCase(1) and lowerCase(1) and digits(1) and specialChars(1)
//
// Keycloak is what actually enforces them — anything looser here just lets the
// user submit a password Keycloak then rejects, with a far worse error than the
// inline checklist. Keep the two in sync.
export const PASSWORD_MIN_LENGTH = 12

export interface PasswordChecks {
  length: boolean
  upper: boolean
  lower: boolean
  number: boolean
  symbol: boolean
}

export function getPasswordChecks(password: string): PasswordChecks {
  return {
    length: password.length >= PASSWORD_MIN_LENGTH,
    upper: /[A-Z]/.test(password),
    lower: /[a-z]/.test(password),
    number: /[0-9]/.test(password),
    symbol: /[^A-Za-z0-9]/.test(password),
  }
}

// Rendered in this order by every password checklist.
export const PASSWORD_CHECK_LABELS: [keyof PasswordChecks, string][] = [
  ['length', `At least ${PASSWORD_MIN_LENGTH} characters`],
  ['upper', 'One uppercase letter'],
  ['lower', 'One lowercase letter'],
  ['number', 'One number'],
  ['symbol', 'One symbol'],
]
