import { createFileRoute, Link } from '@tanstack/react-router'
import { MdFolder, MdLock, MdInsertDriveFile, MdPeople, MdBarChart, MdStar } from 'react-icons/md'

export const Route = createFileRoute('/')({
  component: RouteComponent,
})

const FEATURES = [
  {
    icon: MdLock,
    title: 'Encrypted at rest',
    desc: 'Every file is encrypted with a unique AES-256 key before it touches disk. Your data is unreadable without your account.',
  },
  {
    icon: MdFolder,
    title: 'Folder hierarchy',
    desc: 'Organise files into nested folders. Drag files between folders, create new ones on the fly, and navigate instantly.',
  },
  {
    icon: MdInsertDriveFile,
    title: 'In-browser previews',
    desc: 'View images (PNG, JPG, GIF, WebP) and PDFs directly in the browser — no download needed.',
  },
  {
    icon: MdStar,
    title: 'Favourites',
    desc: 'Star any file or folder to pin it to your Favourites page for quick access across sessions.',
  },
  {
    icon: MdPeople,
    title: 'Invite-only registration',
    desc: 'Access is gated by invitation. Admins send time-limited invite links; no one can sign up without one.',
  },
  {
    icon: MdBarChart,
    title: 'Admin dashboard',
    desc: 'Real-time CPU, memory, storage, and network metrics. Manage users, adjust quotas, and send invitations.',
  },
]

function RouteComponent() {
  return (
    <div className="min-h-screen bg-gray-50">
      {/* Hero */}
      <section className="max-w-3xl mx-auto px-6 pt-24 pb-16 text-center">
        <span className="inline-block text-xs font-semibold uppercase tracking-widest text-blue-600 mb-4">
          Self-hosted · Encrypted · Private
        </span>
        <h1 className="text-4xl font-bold text-gray-900 mb-4 leading-tight">
          Your files, on your hardware,<br />under your control.
        </h1>
        <p className="text-gray-500 text-lg mb-8 max-w-xl mx-auto">
          Apollo SFS is a self-hosted encrypted file storage platform. Upload, organise, and preview files from
          any browser — with full AES-256 encryption at rest and invite-only access.
        </p>
        <Link
          to="/login"
          className="inline-block px-8 py-3 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-xl no-underline transition-colors shadow-sm"
        >
          Sign in to your account
        </Link>
      </section>

      {/* Features */}
      <section className="max-w-4xl mx-auto px-6 pb-24">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {FEATURES.map(({ icon: Icon, title, desc }) => (
            <div
              key={title}
              className="bg-white rounded-xl border border-gray-200 px-5 py-5 flex flex-col gap-3"
            >
              <div className="w-9 h-9 rounded-lg bg-blue-50 flex items-center justify-center shrink-0">
                <Icon className="text-blue-600 text-lg" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-gray-900 mb-1">{title}</h3>
                <p className="text-sm text-gray-500 leading-relaxed">{desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-gray-200 py-6 text-center text-xs text-gray-400">
        Apollo SFS — self-hosted encrypted file storage
      </footer>
    </div>
  )
}
