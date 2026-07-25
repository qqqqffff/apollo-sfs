import { test, expect, type Page } from '@playwright/test'
import { mockAuth, mockFavorites, MOCK_SERVER, MOCK_FOLDERS, MOCK_FILES } from './fixtures'

// Drag-and-drop moves have to work at every folder depth, not just at a drive
// root. These run the real app in real Chromium on purpose: a native drag
// session — and the browser's own rules about when it silently abandons one —
// cannot be reproduced with synthetic jsdom events, and the two bugs these
// cover were both invisible to the jsdom suite.
//
//  1. Mounting the drop-target panel in the document flow moved the dragged
//     row while dragstart was still being handled, and the browser silently
//     abandoned the drag: no drop ever fired, no error, while dragenter/
//     dragover kept working so the highlights looked fine. Only reproduced
//     below a drive root — the root view renders nothing gated on a drag
//     being active, so nothing moved there.
//  2. Once that drag survived, the same panel still shoved the row list down
//     mid-drag, landing the drop on whichever row slid under the pointer
//     instead of the folder the user aimed at.
//
// Hence the panel is `fixed` (see FolderView in routes/_auth.client/index.tsx),
// and beginDrag in useFileDrag.ts defers its state flip a frame as a guard.

const PARENT = {
  id: 'fold1', user_id: 'u1', parent_id: null, name: 'Photos', kind: 'regular' as const,
  size_bytes: 0, drive_id: 'drive1', ai_recognition_enabled: false,
  created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
}

const NESTED_A = { ...PARENT, id: 'sub1', parent_id: 'fold1', name: 'Nested A' }
const NESTED_B = { ...PARENT, id: 'sub2', parent_id: 'fold1', name: 'Nested B' }

const FILE_IN_PARENT = {
  id: 'fi9', name: 'inside.txt', size_bytes: 2048, mime_type: 'text/plain',
  folder_id: 'fold1', user_id: 'u1',
  created_at: '2024-01-03T00:00:00Z', updated_at: '2024-01-03T00:00:00Z',
}
const FILE_IN_NESTED = { ...FILE_IN_PARENT, id: 'fi10', name: 'deep.txt', folder_id: 'sub1' }

function contents(folder: unknown, subfolders: unknown[], files: unknown[]) {
  return {
    json: {
      folder,
      subfolders: { items: subfolders, next_token: '' },
      files: { items: files, next_token: '' },
    },
  }
}

async function mockBrowser(page: Page) {
  await mockAuth(page)
  await page.route('**/api/v1/storage/my-servers', (r) => r.fulfill({ json: { servers: [MOCK_SERVER] } }))
  await page.route('**/api/v1/me/preferences', (r) => r.fulfill({ json: {} }))
  await mockFavorites(page)

  // The catch-all goes first so the specific folder routes below win —
  // Playwright evaluates most-recently-added routes first.
  await page.route('**/api/v1/folders**', (r) => r.fulfill(contents(null, MOCK_FOLDERS, MOCK_FILES)))
  await page.route('**/api/v1/folders/fold1', (r) =>
    r.fulfill(contents(PARENT, [NESTED_A, NESTED_B], [FILE_IN_PARENT])))
  await page.route('**/api/v1/folders/sub1', (r) =>
    r.fulfill(contents(NESTED_A, [], [FILE_IN_NESTED])))
  await page.route('**/api/v1/folders/fold1/ancestors', (r) => r.fulfill({ json: { ancestors: [PARENT] } }))
  await page.route('**/api/v1/folders/sub1/ancestors', (r) => r.fulfill({ json: { ancestors: [PARENT, NESTED_A] } }))
}

/** Captures every file-move request the page issues as { fileId, targetFolderId }. */
async function captureMoves(page: Page) {
  const moves: { fileId: string; targetFolderId: unknown }[] = []
  await page.route('**/api/v1/files/*/move', async (route) => {
    const parts = new URL(route.request().url()).pathname.split('/')
    const fileId = parts[parts.length - 2]
    const body = route.request().postDataJSON() as { folder_id?: string }
    moves.push({ fileId, targetFolderId: body?.folder_id })
    await route.fulfill({ json: { ...FILE_IN_PARENT, folder_id: body?.folder_id ?? null } })
  })
  return moves
}

/**
 * Drags `from` onto `to` with real mouse input, aiming at where `to` sat
 * *before* the drag started — which is what a user does, and what catches the
 * list shifting out from under them. Returns the target's box before the drag
 * and again once the drag is live, so a caller can assert nothing moved.
 */
async function dragOnto(page: Page, from: string, to: string) {
  const src = page.getByText(from, { exact: true })
  const dst = page.getByText(to, { exact: true })
  await expect(src).toBeVisible()
  await expect(dst).toBeVisible()

  const s = (await src.boundingBox())!
  const before = (await dst.boundingBox())!
  const aim = { x: before.x + before.width / 2, y: before.y + before.height / 2 }

  await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2)
  await page.mouse.down()
  // Chromium needs a few moves before it promotes the press into a real drag.
  await page.mouse.move(s.x + s.width / 2 + 8, s.y + s.height / 2 + 8, { steps: 4 })
  // Let whatever the app renders in response to the drag settle, so `during`
  // reflects the layout the user is actually aiming into.
  await page.waitForTimeout(150)
  const during = (await dst.boundingBox())!

  await page.mouse.move(aim.x, aim.y, { steps: 12 })
  await page.mouse.move(aim.x + 2, aim.y, { steps: 4 })
  await page.mouse.up()
  await page.waitForTimeout(300)

  return { before, during }
}

test.describe('drag-and-drop move at depth', () => {
  test.beforeEach(async ({ page }) => {
    await mockBrowser(page)
  })

  test('moves a file onto a sibling folder at a drive root', async ({ page }) => {
    const moves = await captureMoves(page)
    await page.goto('/client')

    await dragOnto(page, 'note.txt', 'Documents')

    expect(moves).toEqual([{ fileId: 'fi2', targetFolderId: 'fold2' }])
  })

  test('moves a file onto a sibling folder inside a folder', async ({ page }) => {
    const moves = await captureMoves(page)
    await page.goto('/client?folder=fold1')

    const { before, during } = await dragOnto(page, 'inside.txt', 'Nested B')

    // The row must not move once the drag starts, or the drop lands on a
    // neighbour: this asserted 'sub1' (Nested A) before the panel was floated.
    expect(during.y).toBeCloseTo(before.y, 0)
    expect(moves).toEqual([{ fileId: 'fi9', targetFolderId: 'sub2' }])
  })

  test('shows both stacked drop targets while dragging, and moves to the parent', async ({ page }) => {
    const moves = await captureMoves(page)
    await page.goto('/client?folder=sub1')

    const intoCurrent = page.getByText('Drop here to move into "Nested A"')
    const toParent = page.getByText('Drop here to move to the parent folder')
    await expect(intoCurrent).toHaveCount(0)
    await expect(toParent).toHaveCount(0)

    const src = page.getByText('deep.txt', { exact: true })
    const s = (await src.boundingBox())!
    await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2)
    await page.mouse.down()
    await page.mouse.move(s.x + s.width / 2 + 8, s.y + s.height / 2 + 8, { steps: 4 })
    await page.waitForTimeout(150)

    // Both persist for the whole drag, not just while hovered.
    await expect(intoCurrent).toBeVisible()
    await expect(toParent).toBeVisible()

    const zone = (await toParent.boundingBox())!
    await page.mouse.move(zone.x + zone.width / 2, zone.y + zone.height / 2, { steps: 12 })
    await page.mouse.move(zone.x + zone.width / 2 + 2, zone.y + zone.height / 2, { steps: 4 })
    await page.mouse.up()
    await page.waitForTimeout(300)

    expect(moves).toEqual([{ fileId: 'fi10', targetFolderId: 'fold1' }])
    // Cleaned up when the drag ends.
    await expect(toParent).toHaveCount(0)
  })

  // Holding a drag over a folder row springs it open (HOVER_OPEN_DELAY_MS),
  // which navigates and refetches mid-drag. The drag has to survive that: the
  // row list is pinned to its drag-start snapshot so the grabbed row is never
  // unmounted (unmounting the source kills the drop just as moving it does),
  // and the floating panel retargets to the newly opened folder so there's
  // somewhere to land.
  test('survives a spring-loaded hover-navigate and drops into the opened folder', async ({ page }) => {
    const moves = await captureMoves(page)
    await page.goto('/client?folder=fold1')

    const src = page.getByText('inside.txt', { exact: true })
    const row = page.getByText('Nested A', { exact: true })
    await expect(src).toBeVisible()
    const s = (await src.boundingBox())!
    const r = (await row.boundingBox())!

    await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2)
    await page.mouse.down()
    await page.mouse.move(s.x + s.width / 2 + 8, s.y + s.height / 2 + 8, { steps: 4 })
    await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2, { steps: 10 })
    // Hold past the spring-load delay, jiggling so dragover keeps firing.
    await page.mouse.move(r.x + r.width / 2 + 1, r.y + r.height / 2, { steps: 2 })
    await page.waitForTimeout(1400)

    await expect(page).toHaveURL(/folder=sub1/)
    const intoOpened = page.getByText('Drop here to move into "Nested A"')
    await expect(intoOpened).toBeVisible()

    const zone = (await intoOpened.boundingBox())!
    await page.mouse.move(zone.x + zone.width / 2, zone.y + zone.height / 2, { steps: 10 })
    await page.mouse.move(zone.x + zone.width / 2 + 2, zone.y + zone.height / 2, { steps: 2 })
    await page.mouse.up()
    await page.waitForTimeout(300)

    expect(moves).toEqual([{ fileId: 'fi9', targetFolderId: 'sub1' }])
  })

  test('moves a folder onto a sibling folder inside a folder', async ({ page }) => {
    const moves: { folderId: string; targetFolderId: unknown }[] = []
    await page.route('**/api/v1/folders/*/move', async (route) => {
      const parts = new URL(route.request().url()).pathname.split('/')
      const folderId = parts[parts.length - 2]
      const body = route.request().postDataJSON() as { target_folder_id?: string }
      moves.push({ folderId, targetFolderId: body?.target_folder_id })
      await route.fulfill({ json: { ...NESTED_A, parent_id: body?.target_folder_id ?? null } })
    })

    await page.goto('/client?folder=fold1')
    await dragOnto(page, 'Nested A', 'Nested B')

    expect(moves).toEqual([{ folderId: 'sub1', targetFolderId: 'sub2' }])
  })
})
