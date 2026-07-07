interface Props {
  onClick: () => void
  disabled?: boolean
  loading?: boolean
  label: string
  className?: string
}

const DEFAULT_CLASS =
  'w-full flex items-center justify-center gap-2 px-4 py-3 text-sm font-semibold bg-white hover:bg-gray-50 text-gray-800 border border-gray-300 rounded-xl disabled:opacity-50 transition-colors cursor-pointer'

// GooglePayButton is the shared Google Pay call-to-action used on the interest,
// storage-upgrade, and register payment surfaces. Rendering is gated by the
// caller on useGooglePay().ready; this component is purely presentational.
export function GooglePayButton({ onClick, disabled, loading, label, className }: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={className ?? DEFAULT_CLASS}
    >
      <GooglePayMark />
      {loading ? 'Processing…' : label}
    </button>
  )
}

function GooglePayMark() {
  return (
    <svg viewBox="0 0 41 17" className="h-4 fill-current" aria-hidden="true">
      <path d="M19.526 2.635v4.083h2.518c.6 0 1.096-.202 1.488-.605.403-.402.605-.882.605-1.437 0-.544-.202-1.018-.605-1.422-.392-.413-.888-.62-1.488-.62h-2.518zm0 5.52v4.736h-1.504V1.198h3.99c1.013 0 1.873.337 2.582 1.012.72.675 1.08 1.497 1.08 2.466 0 .991-.36 1.819-1.08 2.482-.697.652-1.559.978-2.583.978h-2.485zm7.668 2.287c0 .676.239 1.234.718 1.673.48.44 1.057.659 1.732.659.937 0 1.71-.352 2.32-1.056l.928.603c-.773 1.09-1.905 1.635-3.396 1.635-1.208 0-2.179-.39-2.914-1.172-.724-.78-1.086-1.763-1.086-2.948 0-1.17.362-2.146 1.086-2.927.735-.792 1.683-1.188 2.846-1.188 1.185 0 2.12.433 2.805 1.3.697.854 1.045 1.92 1.045 3.199l-.016.222h-5.068zm3.556-1.173c-.056-.658-.29-1.177-.7-1.557-.41-.38-.924-.57-1.544-.57-.62 0-1.145.19-1.576.57-.43.38-.682.9-.756 1.557h4.576zm-13.78 7.738h1.518l-5.555-14.96H11.44L5.872 16.994h1.518l1.483-4.013h5.68l1.419 4.013zm-5.695-5.47 2.262-6.11 2.262 6.11H11.275zm-8.96-8.52v3.58h2.327c.627 0 1.15-.214 1.568-.643.43-.44.645-.976.645-1.609 0-.62-.215-1.147-.645-1.581-.418-.43-.941-.644-1.568-.644H2.315V2.52H.8v14.474h1.515v-7.5h2.327c1.078 0 1.99-.378 2.735-1.133.745-.756 1.118-1.674 1.118-2.754 0-1.079-.373-1.997-1.118-2.753C6.632 2.1 5.72 1.722 4.642 1.722H2.315z" />
    </svg>
  )
}
