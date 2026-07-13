// Mirrors the web frontend's Tailwind palette so both clients read as one
// product: primary = blue-600, background = gray-50, cards = white with a
// gray-200 border and rounded-xl corners (see frontend/src/index.css usage).
export const colors = {
  primary: '#2563eb',        // blue-600
  primaryHover: '#1d4ed8',   // blue-700
  primaryLight: '#dbeafe',   // blue-100
  primaryLighter: '#eff6ff', // blue-50
  background: '#f9fafb',     // gray-50
  surface: '#ffffff',
  border: '#e5e7eb',         // gray-200
  divider: '#f3f4f6',        // gray-100
  textPrimary: '#111827',    // gray-900
  textSecondary: '#6b7280',  // gray-500
  textMuted: '#9ca3af',      // gray-400
  success: '#16a34a',        // green-600
  successBg: '#f0fdf4',      // green-50
  error: '#ef4444',          // red-500
  errorBg: '#fef2f2',        // red-50
  warning: '#f59e0b',        // amber-500
  warningBg: '#fffbeb',      // amber-50
  info: '#3b82f6',           // blue-500
  infoBg: '#eff6ff',         // blue-50
  // Sandbox-payment badges (purple-100 / purple-700 on the web).
  sandbox: '#7e22ce',
  sandboxBg: '#f3e8ff',
  emerald: '#10b981',        // emerald-500 (graphs, fast-tier accents)
  amberDeep: '#b45309',      // amber-700 (badge text)
  mediaAccent: '#7c3aed',
  mediaAccentLighter: '#f5f3ff',
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
};

export const radius = {
  sm: 6,
  md: 8,
  lg: 12,
  xl: 16,
};

export const shadow = {
  sm: {
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  md: {
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
};

// The web's standard card: bg-white border border-gray-200 rounded-xl.
export const card = {
  backgroundColor: colors.surface,
  borderRadius: radius.lg,
  borderWidth: 1,
  borderColor: colors.border,
} as const;
