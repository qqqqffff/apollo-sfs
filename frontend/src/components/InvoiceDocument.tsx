import {
  formatCents,
  type ExpansionInvoice,
  type ExpansionRequest,
} from '../api/billing'

const TIB = 1024 ** 4

function formatCapacity(bytes: number): string {
  if (bytes >= 1024 * TIB) return `${(bytes / (1024 * TIB)).toFixed(1).replace(/\.0$/, '')} PB`
  if (bytes >= TIB) return `${(bytes / TIB).toFixed(1).replace(/\.0$/, '')} TB`
  return `${Math.round(bytes / 1024 ** 3)} GB`
}

// InvoiceDocument renders the invoice as a printable paper-style document —
// the same layout the admin previews when composing it.
export function InvoiceDocument({
  invoice, request,
}: {
  invoice: Pick<ExpansionInvoice, 'invoice_number' | 'line_items' | 'total_cents' | 'deposit_cents' | 'disclosures' | 'notes' | 'sent_at' | 'accept_due_at'>
  request: Pick<ExpansionRequest, 'server_name' | 'storage_type' | 'bytes_requested' | 'username'> | null
}) {
  return (
    <div className="bg-white border border-gray-300 rounded-sm shadow-md px-8 py-7 font-serif" style={{ aspectRatio: 'auto' }}>
      <div className="flex items-start justify-between pb-4 border-b-2 border-gray-800">
        <div>
          <p className="text-xl font-bold text-gray-900 m-0 tracking-wide">Apollo SFS</p>
          <p className="text-xs text-gray-500 m-0 mt-0.5">Self-hosted encrypted file storage</p>
        </div>
        <div className="text-right">
          <p className="text-lg font-bold text-gray-900 m-0 uppercase tracking-widest">Invoice</p>
          <p className="text-xs text-gray-600 m-0 mt-0.5">{invoice.invoice_number}</p>
        </div>
      </div>

      <div className="flex justify-between text-xs text-gray-600 py-3">
        <div>
          <p className="m-0 font-semibold text-gray-800">Billed for</p>
          {request && (
            <>
              <p className="m-0">{formatCapacity(request.bytes_requested)} {request.storage_type === 'nvme' ? 'Fast (NVMe)' : 'Standard (HDD)'} storage</p>
              <p className="m-0">Server: {request.server_name}</p>
            </>
          )}
        </div>
        <div className="text-right">
          <p className="m-0"><span className="font-semibold text-gray-800">Issued:</span> {new Date(invoice.sent_at).toLocaleDateString()}</p>
          <p className="m-0"><span className="font-semibold text-gray-800">Due:</span> {new Date(invoice.accept_due_at).toLocaleDateString()}</p>
        </div>
      </div>

      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-gray-800">
            <th className="text-left py-1.5 font-semibold text-gray-800">Description</th>
            <th className="text-right py-1.5 font-semibold text-gray-800 w-32">Amount</th>
          </tr>
        </thead>
        <tbody>
          {invoice.line_items.map((li, i) => (
            <tr key={i} className="border-b border-gray-200">
              <td className="py-1.5 text-gray-700">{li.description || <span className="text-gray-300">—</span>}</td>
              <td className="py-1.5 text-right text-gray-700">{formatCents(li.amount_cents)}</td>
            </tr>
          ))}
          <tr>
            <td className="py-2 text-right font-semibold text-gray-800">Total</td>
            <td className="py-2 text-right font-bold text-gray-900">{formatCents(invoice.total_cents)}</td>
          </tr>
          {invoice.deposit_cents > 0 && (
            <>
              <tr>
                <td className="py-0.5 text-right text-gray-600 text-xs">Deposit due on acceptance</td>
                <td className="py-0.5 text-right text-gray-800 text-xs">{formatCents(invoice.deposit_cents)}</td>
              </tr>
              <tr>
                <td className="py-0.5 text-right text-gray-600 text-xs">Balance due after provisioning</td>
                <td className="py-0.5 text-right text-gray-800 text-xs">{formatCents(invoice.total_cents - invoice.deposit_cents)}</td>
              </tr>
            </>
          )}
        </tbody>
      </table>

      {invoice.notes && (
        <div className="mt-4">
          <p className="text-xs font-semibold text-gray-800 m-0 mb-0.5">Notes</p>
          <p className="text-xs text-gray-600 m-0 whitespace-pre-wrap">{invoice.notes}</p>
        </div>
      )}
      {invoice.disclosures && (
        <div className="mt-3 pt-3 border-t border-gray-200">
          <p className="text-[10px] text-gray-400 m-0 whitespace-pre-wrap">{invoice.disclosures}</p>
        </div>
      )}
    </div>
  )
}
