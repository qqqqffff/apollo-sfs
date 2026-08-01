import { useMutation, useQueryClient } from '@tanstack/react-query'
import { MdPersonOff } from 'react-icons/md'
import { logout } from '../api/auth'
import { meQueryOptions } from '../api/me'
import { clearSkipDeleteCookie } from './DeleteConfirmModal'

// Blocks the public account-creation flows (group-invite slot picker, the
// register page) when the visitor already has an active session. Registering
// a second account while signed in would leave the browser holding two
// identities at once (the old session cookie vs. whatever the new account
// sets), so they must sign out first. Signing out just clears the session —
// the calling page re-renders in its normal signed-out state on its own
// (same URL, no navigation needed).
export function AlreadySignedInNotice({ username }: { username?: string }) {
  const queryClient = useQueryClient()
  const logoutMutation = useMutation({
    mutationFn: logout,
    onSettled: () => {
      clearSkipDeleteCookie()
      // Flip synchronously before clearing — see __root.tsx's session-expired
      // handler for why clear() alone can leave isAuthenticated observers stale.
      queryClient.setQueryData(meQueryOptions.queryKey, null)
      queryClient.clear()
    },
  })

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-8 max-w-md w-full text-center flex flex-col items-center gap-3">
      <MdPersonOff className="text-4xl text-amber-500" />
      <h1 className="text-lg font-semibold text-gray-900 m-0">You're already signed in</h1>
      <p className="text-sm text-gray-500 m-0">
        {username && <>You're signed in as <span className="font-medium text-gray-700">{username}</span>. </>}
        Sign out to create a new account with this invitation.
      </p>
      <button
        type="button"
        onClick={() => logoutMutation.mutate()}
        disabled={logoutMutation.isPending}
        className="mt-1 px-5 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium disabled:opacity-50 cursor-pointer transition-colors"
      >
        {logoutMutation.isPending ? 'Signing out…' : 'Sign out and continue'}
      </button>
    </div>
  )
}
