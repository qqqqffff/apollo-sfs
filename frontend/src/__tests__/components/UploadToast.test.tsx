import { render, screen, act, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import { UploadToast } from '../../components/UploadToast'
import type { UploadProgress } from '../../hooks/useFileUpload'

const singleItem: UploadProgress['items'][number] = {
  name: 'photo.jpg',
  size: 1024 * 1024,
  loaded: 0,
  status: 'queued',
}

function makeProgress(overrides: Partial<UploadProgress> = {}): UploadProgress {
  return {
    status: 'uploading',
    items: [singleItem],
    totalBytes: 1024 * 1024,
    loadedBytes: 0,
    speedBps: 0,
    succeeded: 0,
    failed: 0,
    ...overrides,
  }
}

describe('UploadToast', () => {
  test('renders nothing when status is idle', () => {
    const { container } = render(
      <UploadToast progress={makeProgress({ status: 'idle' })} onDismiss={() => {}} />,
    )
    expect(container.firstChild).toBeNull()
  })

  test('shows "Uploading" label while uploading', () => {
    render(<UploadToast progress={makeProgress()} onDismiss={() => {}} />)
    expect(screen.getByText('Uploading')).toBeInTheDocument()
  })

  test('shows "Complete" label when complete', () => {
    render(
      <UploadToast
        progress={makeProgress({ status: 'complete', loadedBytes: 1024 * 1024, succeeded: 1 })}
        onDismiss={() => {}}
      />,
    )
    expect(screen.getByText('Complete')).toBeInTheDocument()
  })

  test('shows "Partial failure" label when partially failed', () => {
    render(
      <UploadToast
        progress={makeProgress({ status: 'partial', succeeded: 1, failed: 1 })}
        onDismiss={() => {}}
      />,
    )
    expect(screen.getByText('Partial failure')).toBeInTheDocument()
  })

  test('shows "Failed" label when all uploads failed', () => {
    render(
      <UploadToast progress={makeProgress({ status: 'allFailed', failed: 1 })} onDismiss={() => {}} />,
    )
    expect(screen.getByText('Failed')).toBeInTheDocument()
  })

  test('shows the file name in the row', () => {
    render(<UploadToast progress={makeProgress()} onDismiss={() => {}} />)
    expect(screen.getByText('photo.jpg')).toBeInTheDocument()
  })

  test('no dismiss button while uploading', () => {
    render(<UploadToast progress={makeProgress()} onDismiss={() => {}} />)
    expect(screen.queryByLabelText('Dismiss')).not.toBeInTheDocument()
  })

  test('dismiss button present when not uploading', () => {
    render(
      <UploadToast progress={makeProgress({ status: 'complete' })} onDismiss={() => {}} />,
    )
    expect(screen.getByLabelText('Dismiss')).toBeInTheDocument()
  })

  test('auto-dismisses 5 seconds after status becomes complete', () => {
    jest.useFakeTimers()
    const onDismiss = jest.fn()
    render(
      <UploadToast progress={makeProgress({ status: 'complete' })} onDismiss={onDismiss} />,
    )
    act(() => jest.advanceTimersByTime(5000))
    expect(onDismiss).toHaveBeenCalledTimes(1)
    jest.useRealTimers()
  })
})

describe('UploadToast unit="items" (delete toast)', () => {
  const items: UploadProgress['items'] = [
    { name: 'a.txt', size: 10, loaded: 10, status: 'done' },
    { name: 'b.txt', size: 20, loaded: 0, status: 'uploading' },
    { name: 'c.txt', size: 5, loaded: 0, status: 'queued' },
  ]

  test('shows an object-count summary instead of bytes while in progress', () => {
    render(
      <UploadToast
        progress={makeProgress({ items, totalBytes: 35, loadedBytes: 10 })}
        onDismiss={() => {}}
        unit="items"
        doneWord="deleted"
      />,
    )
    expect(screen.getByText('1 / 3 objects deleted')).toBeInTheDocument()
    expect(screen.queryByText(/KB|MB|GB| B$/)).not.toBeInTheDocument()
  })

  test('shows an object-count summary when complete', () => {
    render(
      <UploadToast
        progress={makeProgress({ status: 'complete', items, succeeded: 3 })}
        onDismiss={() => {}}
        unit="items"
        doneWord="deleted"
      />,
    )
    expect(screen.getByText('3 objects deleted')).toBeInTheDocument()
  })

  test('shows deleted/failed counts on partial failure, from the recursive object tally', () => {
    render(
      <UploadToast
        // A single folder target (one row in `items`) whose subtree had 10
        // real files, 8 of which deleted successfully — the object-level
        // count matters here, not the one-row target-level succeeded/failed.
        progress={makeProgress({
          status: 'partial', items, succeeded: 0, failed: 1, totalObjects: 10, doneObjects: 8,
        })}
        onDismiss={() => {}}
        unit="items"
        doneWord="deleted"
      />,
    )
    expect(screen.getByText('8 deleted · 2 failed')).toBeInTheDocument()
  })

  test('defaults to bytes when unit is omitted', () => {
    render(<UploadToast progress={makeProgress()} onDismiss={() => {}} />)
    expect(screen.getByText('0 B / 1.0 MB')).toBeInTheDocument()
  })

  test('shows bytes freed alongside the object count', () => {
    render(
      <UploadToast
        progress={makeProgress({ items, totalBytes: 35, loadedBytes: 10 })}
        onDismiss={() => {}}
        unit="items"
        doneWord="deleted"
      />,
    )
    expect(screen.getByText('10 B / 35 B freed')).toBeInTheDocument()
  })

  test('shows an objects/sec rate and ETA', () => {
    render(
      <UploadToast
        progress={makeProgress({
          items, totalBytes: 35, loadedBytes: 10, totalObjects: 2000, doneObjects: 800, objectsPerSec: 100,
        })}
        onDismiss={() => {}}
        unit="items"
      />,
    )
    // 1200 objects left at 100/s = 12s.
    expect(screen.getByText('~100/s · ~12s')).toBeInTheDocument()
  })
})

describe('UploadToast ETA (unit="bytes", the upload toast)', () => {
  test('shows a speed and ETA once a rate is established', () => {
    render(
      <UploadToast
        progress={makeProgress({ totalBytes: 2_000_000, loadedBytes: 800_000, speedBps: 100_000 })}
        onDismiss={() => {}}
      />,
    )
    // 1.2M bytes left at 100 KB/s (97.7 KB/s exactly) = 12s.
    expect(screen.getByText('98 KB/s · ~12s')).toBeInTheDocument()
  })

  test('shows no ETA when there is no throughput yet', () => {
    render(
      <UploadToast
        progress={makeProgress({ totalBytes: 1_000_000, loadedBytes: 0, speedBps: 0 })}
        onDismiss={() => {}}
      />,
    )
    expect(screen.queryByText(/~/)).not.toBeInTheDocument()
  })
})

describe('UploadToast pause/cancel controls (same control the backup flows use)', () => {
  test('no pause/cancel controls when onRequestCancel is omitted (e.g. drive migration)', () => {
    render(<UploadToast progress={makeProgress()} onDismiss={() => {}} />)
    expect(screen.queryByText('Pause')).not.toBeInTheDocument()
    expect(screen.queryByText('Cancel')).not.toBeInTheDocument()
  })

  test('shows Pause and Cancel while uploading when onRequestCancel is given', () => {
    render(
      <UploadToast
        progress={makeProgress()}
        onDismiss={() => {}}
        onTogglePause={() => {}}
        onRequestCancel={() => {}}
      />,
    )
    expect(screen.getByText('Pause')).toBeInTheDocument()
    expect(screen.getByText('Cancel')).toBeInTheDocument()
  })

  test('clicking Cancel calls onRequestCancel, not a direct cancel', () => {
    const onRequestCancel = jest.fn()
    render(
      <UploadToast
        progress={makeProgress()}
        onDismiss={() => {}}
        onTogglePause={() => {}}
        onRequestCancel={onRequestCancel}
      />,
    )
    fireEvent.click(screen.getByText('Cancel'))
    expect(onRequestCancel).toHaveBeenCalledTimes(1)
  })

  test('clicking Pause calls onTogglePause', () => {
    const onTogglePause = jest.fn()
    render(
      <UploadToast
        progress={makeProgress()}
        onDismiss={() => {}}
        onTogglePause={onTogglePause}
        onRequestCancel={() => {}}
      />,
    )
    fireEvent.click(screen.getByText('Pause'))
    expect(onTogglePause).toHaveBeenCalledTimes(1)
  })

  test('shows "Paused" label and a Resume button when paused', () => {
    render(
      <UploadToast
        progress={makeProgress()}
        onDismiss={() => {}}
        paused
        onTogglePause={() => {}}
        onRequestCancel={() => {}}
      />,
    )
    expect(screen.getByText('Paused')).toBeInTheDocument()
    expect(screen.getByText('Resume')).toBeInTheDocument()
  })

  test('shows the "Cancelled" label and status once the run stops', () => {
    render(
      <UploadToast
        progress={makeProgress({ status: 'cancelled', succeeded: 2, loadedBytes: 20 })}
        onDismiss={() => {}}
      />,
    )
    expect(screen.getByText('Cancelled')).toBeInTheDocument()
    expect(screen.getByText('2 uploaded — cancelled')).toBeInTheDocument()
    // Not "uploading" any more, so the pause/cancel controls are gone and
    // dismiss is available again, same as complete/failed/partial.
    expect(screen.getByLabelText('Dismiss')).toBeInTheDocument()
  })
})
