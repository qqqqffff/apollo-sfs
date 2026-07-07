import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import {
  MdClose,
  MdCreateNewFolder,
  MdFolder,
  MdFolderShared,
  MdLink,
  MdPhotoLibrary,
  MdStar,
  MdVpnKey,
} from 'react-icons/md'
import { meQueryOptions } from '../api/me'
import { useImpersonation } from '../context/ImpersonationContext'
import { FileServerLinksCard } from './FileServerLinksCard'

// Actions the sidebar can fire on the files page. They travel as the ?action=
// search param so they work from any sub-page (favorites, shared): the files
// page picks the action up on mount, triggers it, and clears the param.
export type FilesAction = 'new-folder' | 'new-collection' | 'google-backup'

export function parseFilesAction(v: unknown): FilesAction | undefined {
  return v === 'new-folder' || v === 'new-collection' || v === 'google-backup'
    ? v
    : undefined
}

// FilesLayout wraps the files page and its sub-pages (favorites, shared) with
// the shared left control panel.
export function FilesLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col lg:flex-row gap-6 items-start">
      <FilesSidebar />
      <div className="flex-1 min-w-0 w-full">{children}</div>
    </div>
  )
}

function FilesSidebar() {
  const navigate = useNavigate()
  const { data: user } = useQuery(meQueryOptions)
  const { impersonatedUser } = useImpersonation()
  const readOnly = impersonatedUser !== null
  const isPremium = user?.is_premium || user?.is_admin
  const hasGoogleLinked = user?.linked_providers?.includes('google') ?? false
  const [showFileServerLinks, setShowFileServerLinks] = useState(false)

  // Preserve the folder the user is currently browsing so "New folder" etc.
  // create inside it rather than jumping back to the root.
  const search = useSearch({ strict: false }) as { folder?: string }

  function fireAction(action: FilesAction) {
    navigate({
      to: '/client',
      search: { file: undefined, folder: search.folder, action },
    })
  }

  return (
    <aside className="w-full lg:w-52 lg:shrink-0 lg:sticky lg:top-20">
      <nav className="flex lg:flex-col gap-1 overflow-x-auto lg:overflow-visible pb-1 lg:pb-0">
        <SidebarLink to="/client" exact icon={<MdFolder className="text-blue-400" />}>Files</SidebarLink>
        <SidebarLink to="/client/favorites" icon={<MdStar className="text-amber-400" />}>Favorites</SidebarLink>
        <SidebarLink to="/client/shared" icon={<MdFolderShared className="text-blue-400" />}>Shared</SidebarLink>
      </nav>

      {!readOnly && (
        <div className="mt-2 lg:mt-4 lg:pt-4 lg:border-t lg:border-gray-200">
          <p className="hidden lg:block text-xs font-semibold text-gray-400 uppercase tracking-wider m-0 mb-2 px-3">
            Actions
          </p>
          <div className="flex lg:flex-col gap-1 flex-wrap lg:flex-nowrap">
            <SidebarButton
              icon={<MdCreateNewFolder className="text-gray-500" />}
              onClick={() => fireAction('new-folder')}
            >
              New folder
            </SidebarButton>
            {isPremium && (
              <SidebarButton
                icon={<MdPhotoLibrary className="text-purple-400" />}
                onClick={() => fireAction('new-collection')}
              >
                New collection
              </SidebarButton>
            )}
            {isPremium && (
              <SidebarButton
                icon={<MdVpnKey className="text-gray-500" />}
                onClick={() => navigate({ to: '/settings/api-keys' })}
              >
                API Keys
              </SidebarButton>
            )}
            {isPremium && (
              <SidebarButton
                icon={<MdLink className="text-blue-500" />}
                onClick={() => setShowFileServerLinks(true)}
              >
                File server links
              </SidebarButton>
            )}
            {isPremium && hasGoogleLinked && (
              <SidebarButton icon={<GoogleIcon />} onClick={() => fireAction('google-backup')}>
                Google Backup
              </SidebarButton>
            )}
          </div>
        </div>
      )}

      {showFileServerLinks && (
        <FileServerLinksDialog onClose={() => setShowFileServerLinks(false)} />
      )}
    </aside>
  )
}

function SidebarLink({
  to, exact, icon, children,
}: { to: string; exact?: boolean; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <Link
      to={to}
      activeOptions={{ exact: !!exact, includeSearch: false }}
      className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 transition-colors whitespace-nowrap no-underline"
      activeProps={{ className: 'flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-blue-600 bg-blue-50 font-medium whitespace-nowrap no-underline' }}
    >
      <span className="text-lg flex items-center">{icon}</span>
      {children}
    </Link>
  )
}

function SidebarButton({
  icon, onClick, children,
}: { icon: React.ReactNode; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2 w-auto lg:w-full px-3 py-2 rounded-lg text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 cursor-pointer bg-transparent border-0 text-left transition-colors whitespace-nowrap"
    >
      <span className="text-lg flex items-center">{icon}</span>
      {children}
    </button>
  )
}

// FileServerLinksDialog hosts the same management card used on the profile
// page inside a modal, so links can be managed from the files control panel.
function FileServerLinksDialog({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-130 max-w-[94vw] max-h-[90vh] overflow-y-auto relative"
      >
        <button
          onClick={onClose}
          aria-label="Close file server links"
          className="absolute top-3 right-4 z-10 text-gray-400 hover:text-gray-600 cursor-pointer bg-transparent border-0 p-0"
        >
          <MdClose className="text-xl" />
        </button>
        <FileServerLinksCard />
      </div>
    </div>
  )
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="w-4 h-4" aria-hidden="true">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
    </svg>
  )
}
