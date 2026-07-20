import { useEffect, useState } from 'react'
import { MdAlternateEmail } from 'react-icons/md'
import type { EmailProvider } from '../api/emailProviders'
import { LastSyncNote } from './LastSyncNote'

interface Props {
  onCancel: () => void
  onContinue: (provider: EmailProvider) => void
}

// EmailProviderSelectModal is the first step of an email backup: pick which
// mail provider to sign into (mirrors GoogleServiceSelectModal).
export function EmailProviderSelectModal({ onCancel, onContinue }: Props) {
  const [provider, setProvider] = useState<EmailProvider>('gmail')

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onCancel])

  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [])

  const rows: { key: EmailProvider; label: string; desc: string; icon: React.ReactNode }[] = [
    {
      key: 'gmail',
      label: 'Gmail',
      desc: 'Back up mail from a Google account',
      icon: <GmailIcon />,
    },
    {
      key: 'microsoft',
      label: 'Microsoft / Outlook',
      desc: 'Back up mail from an Outlook or Microsoft 365 account',
      icon: <MicrosoftIcon />,
    },
  ]

  return (
    <div
      onClick={onCancel}
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-xl shadow-xl w-96 max-w-[92vw] p-6 flex flex-col gap-4"
      >
        <div className="flex items-center gap-2">
          <MdAlternateEmail className="text-teal-500 text-xl" />
          <h3 className="text-base font-semibold text-gray-900 m-0">Which email account do you want to back up?</h3>
        </div>

        <div className="flex flex-col divide-y divide-gray-100">
          {rows.map((row) => (
            <button
              key={row.key}
              onClick={() => setProvider(row.key)}
              className="flex items-center gap-3 py-3 text-left hover:bg-gray-50 rounded-lg px-1 transition-colors cursor-pointer"
            >
              <div className="w-9 h-9 rounded-lg bg-gray-100 flex items-center justify-center shrink-0">
                {row.icon}
              </div>
              <div className="flex-1">
                <div className="text-sm font-semibold text-gray-900">{row.label}</div>
                <div className="text-xs text-gray-500 mt-0.5">{row.desc}</div>
              </div>
              <div
                className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors ${
                  provider === row.key ? 'bg-blue-600 border-blue-600' : 'border-gray-300'
                }`}
              >
                {provider === row.key && (
                  <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 12 12">
                    <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </div>
            </button>
          ))}
        </div>

        <LastSyncNote kind="email" />

        <p className="text-xs text-gray-400 m-0">
          You&apos;ll sign in to the account in a popup. Apollo SFS never stores your email password —
          messages are fetched in your browser and saved encrypted to your storage.
        </p>

        <div className="flex gap-2 pt-1">
          <button
            onClick={onCancel}
            className="flex-1 px-4 py-2 text-sm rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 cursor-pointer transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => onContinue(provider)}
            className="flex-1 px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium cursor-pointer transition-colors"
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  )
}

function GmailIcon() {
  return (
    <svg viewBox="0 0 24 24" className="w-5 h-5" aria-hidden="true">
      <path d="M2 6.5V18a1.5 1.5 0 0 0 1.5 1.5H6V9.75L12 14l6-4.25V19.5h2.5A1.5 1.5 0 0 0 22 18V6.5A1.5 1.5 0 0 0 20.5 5h-.55L12 10.75 4.05 5H3.5A1.5 1.5 0 0 0 2 6.5z" fill="#EA4335"/>
      <path d="M6 19.5V9.75L2 6.5V18a1.5 1.5 0 0 0 1.5 1.5H6z" fill="#4285F4"/>
      <path d="M18 19.5h2.5A1.5 1.5 0 0 0 22 18V6.5l-4 3.25V19.5z" fill="#34A853"/>
      <path d="M12 10.75 19.95 5H4.05L12 10.75z" fill="#FBBC05"/>
    </svg>
  )
}

function MicrosoftIcon() {
  return (
    <svg viewBox="0 0 24 24" className="w-5 h-5" aria-hidden="true">
      <rect x="3" y="3" width="8.5" height="8.5" fill="#F25022"/>
      <rect x="12.5" y="3" width="8.5" height="8.5" fill="#7FBA00"/>
      <rect x="3" y="12.5" width="8.5" height="8.5" fill="#00A4EF"/>
      <rect x="12.5" y="12.5" width="8.5" height="8.5" fill="#FFB900"/>
    </svg>
  )
}
