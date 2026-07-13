import { createContext, useContext, useEffect, useState } from 'react'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import {
  MdAddCircleOutline,
  MdArrowBack,
  MdClose,
  MdCreateNewFolder,
  MdFolder,
  MdFolderShared,
  MdLink,
  MdMenu,
  MdPhotoLibrary,
  MdStar,
  MdVpnKey,
} from 'react-icons/md'
import { meQueryOptions } from '../api/me'
import { useImpersonation } from '../context/ImpersonationContext'
import { FileServerLinksCard, useCanCreateFileServerLink } from './FileServerLinksCard'
import { FileServerLinkCreateForm } from './FileServerLinkModal'
import { listFileServerLinks } from '../api/fileServerLinks'

// Actions the sidebar can fire on the files page. They travel as the ?action=
// search param so they work from any sub-page (favorites, shared): the files
// page picks the action up on mount, triggers it, and clears the param.
export type FilesAction = 'new-folder' | 'new-collection' | 'google-backup'

export function parseFilesAction(v: unknown): FilesAction | undefined {
  return v === 'new-folder' || v === 'new-collection' || v === 'google-backup'
    ? v
    : undefined
}

// Below the `lg` breakpoint the control panel becomes a slide-in drawer
// instead of a static column — this context lets any page under FilesLayout
// (client, favorites, shared) place a menu-toggle button in its own header
// row rather than FilesLayout dictating where it goes.
const FilesSidebarContext = createContext<{ open: boolean; setOpen: (open: boolean) => void } | null>(null)

// FilesLayout wraps the files page and its sub-pages (favorites, shared) with
// the shared left control panel.
export function FilesLayout({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false)

  // Prevent background scroll while the mobile drawer is open.
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [open])

  return (
    <FilesSidebarContext.Provider value={{ open, setOpen }}>
      <div className="flex flex-col lg:flex-row gap-6 items-start">
        <FilesSidebar open={open} onClose={() => setOpen(false)} />
        <div className="flex-1 min-w-0 w-full">{children}</div>
      </div>
    </FilesSidebarContext.Provider>
  )
}

// FilesSidebarToggle opens the drawer version of the control panel on
// displays narrower than `lg` (1024px). Place it in a page's own header row
// next to the title — it renders nothing (via lg:hidden) at wider sizes,
// where the panel is already visible as a static sidebar.
export function FilesSidebarToggle() {
  const ctx = useContext(FilesSidebarContext)
  return (
    <button
      onClick={() => ctx?.setOpen(true)}
      aria-label="Open files menu"
      className="lg:hidden inline-flex items-center justify-center w-9 h-9 shrink-0 rounded-lg border border-gray-200 text-gray-500 hover:text-gray-900 hover:bg-gray-100 cursor-pointer bg-white transition-colors"
    >
      <MdMenu className="text-lg" />
    </button>
  )
}

function FilesSidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
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

  useEffect(() => {
    if (!open) return
    function handleKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open, onClose])

  function fireAction(action: FilesAction) {
    navigate({
      to: '/client',
      search: { file: undefined, folder: search.folder, action },
    })
    onClose()
  }

  return (
    <>
      {/* Backdrop — mobile drawer only */}
      {open && (
        <div
          onClick={onClose}
          aria-hidden="true"
          className="lg:hidden fixed inset-0 z-[55] bg-black/40"
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-[60] w-72 max-w-[80vw] overflow-y-auto bg-white p-4 shadow-xl transition-transform duration-200 ease-in-out ${open ? 'translate-x-0' : '-translate-x-full'} lg:static lg:z-auto lg:w-52 lg:max-w-none lg:shrink-0 lg:sticky lg:top-20 lg:translate-x-0 lg:overflow-visible lg:bg-transparent lg:p-0 lg:shadow-none`}
      >
        <div className="flex items-center justify-between mb-3 lg:hidden">
          <span className="text-sm font-semibold text-gray-900">Files menu</span>
          <button
            onClick={onClose}
            aria-label="Close files menu"
            className="text-gray-400 hover:text-gray-600 cursor-pointer bg-transparent border-0 p-0.5"
          >
            <MdClose className="text-xl" />
          </button>
        </div>

        <nav className="flex flex-col gap-1">
          <SidebarLink to="/client" exact icon={<MdFolder className="text-blue-400" />} onClick={onClose}>Files</SidebarLink>
          <SidebarLink to="/client/favorites" icon={<MdStar className="text-amber-400" />} onClick={onClose}>Favorites</SidebarLink>
          <SidebarLink to="/client/shared" icon={<MdFolderShared className="text-blue-400" />} onClick={onClose}>Shared</SidebarLink>
        </nav>

        {!readOnly && (
          <div className="mt-2 lg:mt-4 lg:pt-4 lg:border-t lg:border-gray-200">
            <p className="hidden lg:block text-xs font-semibold text-gray-400 uppercase tracking-wider m-0 mb-2 px-3">
              Actions
            </p>
            <div className="flex flex-col gap-1">
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
                  onClick={() => { navigate({ to: '/settings/api-keys' }); onClose() }}
                >
                  API Keys
                </SidebarButton>
              )}
              {isPremium && (
                <SidebarButton
                  icon={<MdLink className="text-blue-500" />}
                  onClick={() => { setShowFileServerLinks(true); onClose() }}
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
      </aside>

      {showFileServerLinks && (
        <FileServerLinksDialog onClose={() => setShowFileServerLinks(false)} />
      )}
    </>
  )
}

function SidebarLink({
  to, exact, icon, children, onClick,
}: { to: string; exact?: boolean; icon: React.ReactNode; children: React.ReactNode; onClick?: () => void }) {
  return (
    <Link
      to={to}
      activeOptions={{ exact: !!exact, includeSearch: false }}
      onClick={onClick}
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
      className="flex items-center gap-2 w-full px-3 py-2 rounded-lg text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 cursor-pointer bg-transparent border-0 text-left transition-colors whitespace-nowrap"
    >
      <span className="text-lg flex items-center">{icon}</span>
      {children}
    </button>
  )
}

// FileServerLinksDialog hosts the same management card used on the profile
// page inside a modal, so links can be managed from the files control panel.
// It owns a single backdrop and header shared by both the list and create
// views (switched internally) — the header holds a back button in the
// create view and always-visible "New link"/close controls placed in normal
// flex flow, so nothing overlaps and the backdrop dim never stacks when
// moving between views.
function FileServerLinksDialog({ onClose }: { onClose: () => void }) {
  const [view, setView] = useState<'list' | 'create'>('list')

  const { data } = useQuery({
    queryKey: ['file-server-links'],
    queryFn: listFileServerLinks,
  })
  const links = data?.items ?? []
  const { canCreate } = useCanCreateFileServerLink(links)

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
        className="bg-white rounded-xl shadow-xl w-130 max-w-[94vw] max-h-[90vh] flex flex-col overflow-hidden"
      >
        <div className="flex items-center justify-between gap-2 px-5 py-4 border-b border-gray-100 shrink-0">
          <span className="flex items-center gap-2 min-w-0">
            {view === 'create' && (
              <button
                onClick={() => setView('list')}
                aria-label="Back to file server links"
                className="shrink-0 text-gray-400 hover:text-gray-600 cursor-pointer bg-transparent border-0 p-0"
              >
                <MdArrowBack className="text-lg" />
              </button>
            )}
            <h3 className="text-sm font-semibold text-gray-800 m-0 flex items-center gap-2 truncate">
              <MdLink className="text-blue-600 text-base shrink-0" />
              {view === 'create' ? 'New file server link' : 'File server links'}
            </h3>
          </span>
          <span className="flex items-center gap-3 shrink-0">
            {view === 'list' && canCreate && (
              <button
                onClick={() => setView('create')}
                className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 bg-transparent border-0 p-0 cursor-pointer font-medium transition-colors"
              >
                <MdAddCircleOutline className="text-sm" /> New link
              </button>
            )}
            <button
              onClick={onClose}
              aria-label="Close file server links"
              className="text-gray-400 hover:text-gray-600 cursor-pointer bg-transparent border-0 p-0"
            >
              <MdClose className="text-xl" />
            </button>
          </span>
        </div>

        <div className="px-5 py-4 overflow-y-auto">
          {view === 'list' ? (
            <FileServerLinksCard hideHeader onNewLink={() => setView('create')} />
          ) : (
            <FileServerLinkCreateForm existingLinks={links} isFirstLink={links.length === 0} />
          )}
        </div>
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
