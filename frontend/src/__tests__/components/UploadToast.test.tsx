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
