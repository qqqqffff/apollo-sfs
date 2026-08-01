import { render, screen, act } from '@testing-library/react'
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

  test('shows deleted/failed counts on partial failure', () => {
    render(
      <UploadToast
        progress={makeProgress({ status: 'partial', items, succeeded: 2, failed: 1 })}
        onDismiss={() => {}}
        unit="items"
        doneWord="deleted"
      />,
    )
    expect(screen.getByText('2 deleted · 1 failed')).toBeInTheDocument()
  })

  test('defaults to bytes when unit is omitted', () => {
    render(<UploadToast progress={makeProgress()} onDismiss={() => {}} />)
    expect(screen.getByText('0 B / 1.0 MB')).toBeInTheDocument()
  })
})
