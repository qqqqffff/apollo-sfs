import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import { InterruptedBackupCard } from '../../components/InterruptedBackupCard'

describe('InterruptedBackupCard', () => {
  test('shows the tallied progress and byte counts', () => {
    render(
      <InterruptedBackupCard
        icon={<span>icon</span>}
        title="Google backup interrupted"
        doneCount={3}
        total={10}
        storedBytes={1024 * 1024 * 3}
        totalBytes={1024 * 1024 * 10}
        busy={false}
        error={null}
        onResume={() => {}}
        onDiscard={() => {}}
      />,
    )
    expect(screen.getByText('Google backup interrupted')).toBeInTheDocument()
    expect(screen.getByText(/3 of 10 items backed up/)).toBeInTheDocument()
    expect(screen.getByText(/3\.0 MB of 10\.0 MB/)).toBeInTheDocument()
  })

  test('clicking Resume and Discard fire their handlers', () => {
    const onResume = jest.fn()
    const onDiscard = jest.fn()
    render(
      <InterruptedBackupCard
        icon={<span>icon</span>}
        title="Email backup interrupted"
        doneCount={1}
        total={2}
        storedBytes={0}
        totalBytes={0}
        busy={false}
        error={null}
        onResume={onResume}
        onDiscard={onDiscard}
      />,
    )
    fireEvent.click(screen.getByText('Resume'))
    fireEvent.click(screen.getByText('Discard'))
    expect(onResume).toHaveBeenCalledTimes(1)
    expect(onDiscard).toHaveBeenCalledTimes(1)
  })

  test('shows "Signing in…" and disables both buttons while busy', () => {
    render(
      <InterruptedBackupCard
        icon={<span>icon</span>}
        title="Google backup interrupted"
        doneCount={1}
        total={2}
        storedBytes={0}
        totalBytes={0}
        busy
        error={null}
        onResume={() => {}}
        onDiscard={() => {}}
      />,
    )
    expect(screen.getByText('Signing in…')).toBeInTheDocument()
    expect(screen.getByText('Signing in…').closest('button')).toBeDisabled()
    expect(screen.getByText('Discard').closest('button')).toBeDisabled()
  })

  test('shows an error message when a resume attempt fails', () => {
    render(
      <InterruptedBackupCard
        icon={<span>icon</span>}
        title="Google backup interrupted"
        doneCount={1}
        total={2}
        storedBytes={0}
        totalBytes={0}
        busy={false}
        error="Could not sign in to Google — try again."
        onResume={() => {}}
        onDiscard={() => {}}
      />,
    )
    expect(screen.getByText('Could not sign in to Google — try again.')).toBeInTheDocument()
  })

  test('omits the byte-count parenthetical when totalBytes is 0 (e.g. a size-less item run)', () => {
    render(
      <InterruptedBackupCard
        icon={<span>icon</span>}
        title="Email backup interrupted"
        doneCount={1}
        total={2}
        storedBytes={0}
        totalBytes={0}
        busy={false}
        error={null}
        onResume={() => {}}
        onDiscard={() => {}}
      />,
    )
    expect(screen.getByText('1 of 2 items backed up before the page refreshed.')).toBeInTheDocument()
  })
})
