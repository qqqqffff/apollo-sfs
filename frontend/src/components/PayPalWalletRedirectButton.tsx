import { useState } from 'react'
import { FaPaypal } from 'react-icons/fa6'

interface Props {
  // Creates the order/subscription server-side (same one Apple Pay/Google
  // Pay/card fields use) and resolves to the PayPal-hosted approval URL for
  // it. Called fresh on every click, mirroring how the other payment methods
  // on this page each independently create their own order on click.
  getApprovalUrl: () => Promise<string>
  onError: (message: string) => void
  disabled?: boolean
}

// The "PayPal" wallet button, as a plain full-page redirect rather than
// react-paypal-js's <PayPalButtons> popup. Third-party iOS browsers (Chrome,
// Firefox, Edge — anything not Safari itself) are required by Apple to run on
// the public WKWebView API, which can't reliably keep a window.open() popup
// alive across the async gap between opening it and navigating it to the
// approval URL once createOrder resolves — only Safari's own WKWebView
// instance gets the OS-level privileges that popup flow needs. The symptom is
// a blank tab that never loads. A top-level redirect has no such popup to
// lose, so it works identically on every browser. The approval page redirects
// back to a return_url the backend built (see PayPalWalletRedirectButton's
// callers), which captures the order and resumes the flow.
export function PayPalWalletRedirectButton({ getApprovalUrl, onError, disabled }: Props) {
  const [loading, setLoading] = useState(false)

  async function handleClick() {
    setLoading(true)
    try {
      const url = await getApprovalUrl()
      if (!url) {
        onError('Could not start PayPal checkout')
        setLoading(false)
        return
      }
      window.location.href = url
      // Intentionally left spinning — the page is navigating away.
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not start checkout')
      setLoading(false)
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled || loading}
      className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold bg-[#ffc439] hover:bg-[#f2ba36] text-[#003087] rounded-lg disabled:opacity-50 cursor-pointer transition-colors"
    >
      <FaPaypal className="text-lg" /> {loading ? 'Redirecting…' : 'PayPal'}
    </button>
  )
}
