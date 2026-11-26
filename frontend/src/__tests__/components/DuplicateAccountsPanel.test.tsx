import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'

const mockQuery = jest.fn()
const mockMutate = jest.fn()
const mockInvalidate = jest.fn()
jest.mock('@tanstack/react-query', () => ({
  useQuery: (...args: any[]) => mockQuery(...args),
  useMutation: () => ({ mutate: mockMutate, isPending: false }),
  useQueryClient: () => ({ invalidateQueries: mockInvalidate }),
}))
jest.mock('../../api/admin', () => ({ getDuplicateUsers: jest.fn(), reconcileDuplicateUsers: jest.fn() }))

import { DuplicateAccountsBanner } from '../../components/DuplicateAccountsPanel'
import type { DuplicateAccountsResponse } from '../../types/api'

const acct = (username: string, email: string, keep: boolean, extra = {}) => ({
  username, email, keep, is_admin: false, is_premium: false, storage_quota_bytes: 1024 ** 3,
  storage_used_bytes: 0, allocations: 1, created_at: '2026-01-01T00:00:00Z', ...extra,
})

const RESPONSE: DuplicateAccountsResponse = {
  groups: [
    {
      action: 'merge', username: 'zoe', email: 'zoe@x.com', quota_bytes: 5 * 1024 ** 3,
      accounts: [acct('zoe', 'zoe@x.com', true, { allocations: 0 }), acct('Zoe', 'Zoe@x.com', false)],
    },
    {
      action: 'merge', username: 'ghost', email: 'ghost@x.com', quota_bytes: 1,
      accounts: [acct('ghost', 'ghost@x.com', true), acct('Ghost', 'g2@x.com', false)],
      blocker: 'no Keycloak login matches any of these usernames',
    },
  ],
  run: null,
}

function setup(data: DuplicateAccountsResponse | undefined) {
  mockQuery.mockImplementation((opts: any) => {
    expect(opts.queryKey).toEqual(['admin', 'users', 'duplicates'])
    return { data }
  })
  return render(<DuplicateAccountsBanner />)
}

beforeEach(() => { mockMutate.mockReset(); mockInvalidate.mockReset() })

test('renders nothing when there are no duplicates', () => {
  const { container } = setup({ groups: [], run: null })
  expect(container).toBeEmptyDOMElement()
})

test('banner summarizes, review lists groups, reconcile starts a run', () => {
  setup(RESPONSE)
  expect(screen.getByText(/2 account issues found — 2 duplicated/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Review' }))

  expect(screen.getByText('Zoe@x.com')).toBeInTheDocument()
  expect(screen.getByText(/Needs a person: no Keycloak login/)).toBeInTheDocument()
  const button = screen.getByRole('button', { name: 'Reconcile 1 group' })
  fireEvent.click(button)
  expect(mockMutate).toHaveBeenCalled()
})

test('reports a finished run and refreshes the user list', () => {
  setup({
    groups: [RESPONSE.groups[1]], // the blocked group is still there
    run: {
      running: false, started_by: 'admin', started_at: '2026-11-25T10:00:00Z', finished_at: '2026-11-25T10:01:00Z',
      indexes_created: false,
      outcomes: [
        { ...RESPONSE.groups[0], status: 'merged', rekey: { checked: 10, current: 7, rekeyed: 3, rekey_bytes: 3072, missing: 0 } },
        { ...RESPONSE.groups[1], status: 'skipped' },
      ],
    },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Review' }))
  expect(screen.getByText(/1 merged · 0 normalized · 1 skipped · 0 failed/)).toBeInTheDocument()
  expect(screen.getByText(/zoe: re-encrypted 3 of 10 objects \(3\.0 KB\)/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Reconcile 0 groups' })).toBeDisabled()
  expect(mockInvalidate).toHaveBeenCalledWith({ queryKey: ['admin', 'users'] })
})
