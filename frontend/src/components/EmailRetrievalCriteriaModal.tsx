import { useEffect, useState } from 'react'
import { MdAlternateEmail } from 'react-icons/md'
import type { EmailProvider, EmailRetrievalCriteria } from '../api/emailProviders'

interface Props {
  provider: EmailProvider
  onCancel: () => void
  onContinue: (criteria: EmailRetrievalCriteria) => void
}

type Mode = EmailRetrievalCriteria['mode']

const MAX_AMOUNT = 10_000
const DEFAULT_AMOUNT = 200
const DEFAULT_SIZE_MB = 500

// EmailRetrievalCriteriaModal is the second step of an email backup (after
// EmailProviderSelectModal, before sign-in): pick how many emails to pull in,
// since the account may have far more than the 200-per-page fetch shows on
// its own. The chosen criteria drives listProviderMessages, which keeps
// paging 200 at a time until it's satisfied.
export function EmailRetrievalCriteriaModal({ provider, onCancel, onContinue }: Props) {
  const [mode, setMode] = useState<Mode>('amount')
  const [amount, setAmount] = useState(String(DEFAULT_AMOUNT))
  const [sinceDate, setSinceDate] = useState('')
  const [sizeValue, setSizeValue] = useState(String(DEFAULT_SIZE_MB))
  const [sizeUnit, setSizeUnit] = useState<'MB' | 'GB'>('MB')

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onCancel])

  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [])

  // Graph (Outlook) doesn't report message sizes, so "until size" can never
  // be satisfied there — see listOutlookMessages.
  const sizeAvailable = provider === 'gmail'
  useEffect(() => {
    if (!sizeAvailable && mode === 'size') setMode('amount')
  }, [sizeAvailable, mode])

  const amountNum = Number(amount)
  const sizeNum = Number(sizeValue)
  const isValid =
    mode === 'amount' ? Number.isInteger(amountNum) && amountNum >= 1 && amountNum <= MAX_AMOUNT :
    mode === 'date' ? sinceDate !== '' :
    Number.isFinite(sizeNum) && sizeNum > 0

  function handleContinue() {
    if (!isValid) return
    if (mode === 'amount') onContinue({ mode: 'amount', amount: amountNum })
    else if (mode === 'date') onContinue({ mode: 'date', sinceDate })
    else onContinue({ mode: 'size', maxBytes: sizeNum * (sizeUnit === 'GB' ? 1024 ** 3 : 1024 ** 2) })
  }

  const rows: { key: Mode; label: string; desc: string; disabled?: boolean }[] = [
    { key: 'amount', label: 'A number of emails', desc: `Your most recent emails, up to ${MAX_AMOUNT.toLocaleString()}.` },
    { key: 'date', label: 'Since a date', desc: 'Every email received on or after a date you pick.' },
    {
      key: 'size',
      label: 'Until a total size',
      desc: sizeAvailable
        ? 'Keeps fetching recent emails until roughly this much data is gathered.'
        : 'Not available for Outlook — Microsoft doesn’t report message sizes.',
      disabled: !sizeAvailable,
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
          <h3 className="text-base font-semibold text-gray-900 m-0">How many emails should we retrieve?</h3>
        </div>

        <div className="flex flex-col divide-y divide-gray-100">
          {rows.map((row) => (
            <button
              key={row.key}
              onClick={() => !row.disabled && setMode(row.key)}
              disabled={row.disabled}
              className={`flex items-center gap-3 py-3 text-left rounded-lg px-1 transition-colors ${
                row.disabled ? 'opacity-40 cursor-not-allowed' : 'hover:bg-gray-50 cursor-pointer'
              }`}
            >
              <div className="flex-1">
                <div className="text-sm font-semibold text-gray-900">{row.label}</div>
                <div className="text-xs text-gray-500 mt-0.5">{row.desc}</div>
              </div>
              <div
                className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors ${
                  mode === row.key ? 'bg-blue-600 border-blue-600' : 'border-gray-300'
                }`}
              >
                {mode === row.key && (
                  <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 12 12">
                    <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </div>
            </button>
          ))}
        </div>

        {mode === 'amount' && (
          <input
            type="number"
            min={1}
            max={MAX_AMOUNT}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="200"
            className="text-sm border border-gray-200 rounded-lg px-3 py-2 text-gray-800 outline-none focus:border-blue-400"
          />
        )}
        {mode === 'date' && (
          <input
            type="date"
            value={sinceDate}
            onChange={(e) => setSinceDate(e.target.value)}
            max={new Date().toISOString().slice(0, 10)}
            className="text-sm border border-gray-200 rounded-lg px-3 py-2 text-gray-800 outline-none focus:border-blue-400"
          />
        )}
        {mode === 'size' && sizeAvailable && (
          <div className="flex gap-2">
            <input
              type="number"
              min={1}
              value={sizeValue}
              onChange={(e) => setSizeValue(e.target.value)}
              placeholder="500"
              className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-2 text-gray-800 outline-none focus:border-blue-400"
            />
            <select
              value={sizeUnit}
              onChange={(e) => setSizeUnit(e.target.value as 'MB' | 'GB')}
              className="text-sm border border-gray-200 rounded-lg px-2 py-2 text-gray-700 bg-white cursor-pointer"
            >
              <option value="MB">MB</option>
              <option value="GB">GB</option>
            </select>
          </div>
        )}

        <p className="text-xs text-gray-400 m-0">
          Large requests are fetched 200 emails at a time and may take a while — you can cancel at any point
          while it loads.
        </p>

        <div className="flex gap-2 pt-1">
          <button
            onClick={onCancel}
            className="flex-1 px-4 py-2 text-sm rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 cursor-pointer transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleContinue}
            disabled={!isValid}
            className="flex-1 px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  )
}
