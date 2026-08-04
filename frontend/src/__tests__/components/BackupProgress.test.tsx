import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { BackupProgressDetails } from '../../components/BackupProgress'

describe('BackupProgressDetails', () => {
  test('shows "Backing up" and the transferred total with no speed/eta when there is no rate yet', () => {
    render(
      <BackupProgressDetails
        currentPath="Photos/IMG_1.jpg"
        storedBytes={1024 * 1024}
        totalBytes={10 * 1024 * 1024}
      />,
    )
    expect(screen.getByText('Backing up')).toBeInTheDocument()
    expect(screen.getByText('Photos/IMG_1.jpg')).toBeInTheDocument()
    expect(screen.getByText(/1\.0 MB of 10\.0 MB transferred/)).toBeInTheDocument()
  })

  test('shows speed and ETA once a rate is established', () => {
    render(
      <BackupProgressDetails
        currentPath="Photos/IMG_1.jpg"
        storedBytes={1_000_000}
        totalBytes={2_000_000}
        speedBps={100_000}
      />,
    )
    // 1,000,000 bytes remaining at 100,000 B/s (97.7 KB/s exactly) = 10s.
    expect(screen.getByText(/98 KB\/s/)).toBeInTheDocument()
    expect(screen.getByText(/~10s/)).toBeInTheDocument()
  })

  test('hides speed/eta while paused, and shows "Paused at" instead of the stage/backing-up label', () => {
    render(
      <BackupProgressDetails
        currentPath="Photos/IMG_1.jpg"
        storedBytes={1_000_000}
        totalBytes={2_000_000}
        speedBps={100_000}
        paused
      />,
    )
    expect(screen.queryByText(/KB\/s/)).not.toBeInTheDocument()
    expect(screen.queryByText(/~/)).not.toBeInTheDocument()
    expect(screen.getByText('Paused at')).toBeInTheDocument()
  })

  test('shows a stage label and live byte sub-progress for the item currently in flight', () => {
    render(
      <BackupProgressDetails
        currentPath="Photos/video.mp4"
        storedBytes={0}
        totalBytes={6_000_000}
        itemStage="downloading"
        itemLoadedBytes={2_000_000}
        itemTotalBytes={6_000_000}
      />,
    )
    expect(screen.getByText('Downloading')).toBeInTheDocument()
    expect(screen.getByText(/1\.9 MB \/ 5\.7 MB/)).toBeInTheDocument()
  })

  test('shows "Uploading" once the item moves to the upload stage', () => {
    render(
      <BackupProgressDetails
        currentPath="Photos/video.mp4"
        storedBytes={0}
        totalBytes={6_000_000}
        itemStage="uploading"
        itemLoadedBytes={4_000_000}
        itemTotalBytes={6_000_000}
      />,
    )
    expect(screen.getByText('Uploading')).toBeInTheDocument()
  })

  test('omits the byte sub-progress when the item total is unknown (a Photos item mid-download)', () => {
    render(
      <BackupProgressDetails
        currentPath="Photos/video.mp4"
        storedBytes={0}
        totalBytes={0}
        itemStage="downloading"
        itemLoadedBytes={2_000_000}
      />,
    )
    expect(screen.getByText('Downloading')).toBeInTheDocument()
    expect(screen.queryByText(/MB \//)).not.toBeInTheDocument()
  })

  test('falls back to "Backing up" when no stage is reported (the email backup flow)', () => {
    render(<BackupProgressDetails currentPath="inbox/message-1.eml" storedBytes={0} totalBytes={1000} />)
    expect(screen.getByText('Backing up')).toBeInTheDocument()
  })
})
