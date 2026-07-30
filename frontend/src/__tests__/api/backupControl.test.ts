import { createBackupControl, readCancelAction } from '../../api/backupControl'

describe('createBackupControl', () => {
  it('starts running and lets work through immediately', async () => {
    const control = createBackupControl()
    expect(control.state()).toBe('running')
    await expect(control.gate()).resolves.toBe(true)
  })

  it('blocks gate() while paused and releases it on resume', async () => {
    const control = createBackupControl()
    control.pause()
    expect(control.isPaused()).toBe(true)

    let released = false
    const gate = control.gate().then((v) => { released = true; return v })
    await Promise.resolve()
    expect(released).toBe(false)

    control.resume()
    await expect(gate).resolves.toBe(true)
  })

  it('releases a paused gate as cancelled', async () => {
    const control = createBackupControl()
    control.pause()
    const gate = control.gate()
    control.cancel()
    await expect(gate).resolves.toBe(false)
    expect(control.isCancelled()).toBe(true)
  })

  it('stays cancelled — resume cannot revive a cancelled run', async () => {
    const control = createBackupControl()
    control.cancel()
    control.resume()
    expect(control.state()).toBe('cancelled')
    await expect(control.gate()).resolves.toBe(false)
  })

  it('notifies subscribers until they unsubscribe', () => {
    const control = createBackupControl()
    const seen: string[] = []
    const off = control.subscribe((s) => seen.push(s))
    control.pause()
    control.resume()
    off()
    control.cancel()
    expect(seen).toEqual(['paused', 'running'])
  })
})

describe('readCancelAction', () => {
  it('reads the current choice', () => {
    const ref = { current: 'keep' as const }
    expect(readCancelAction(ref)).toBe('keep')
    const changed = { current: 'remove' as const }
    expect(readCancelAction(changed)).toBe('remove')
  })
})
