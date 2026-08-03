import { render, screen, fireEvent, act } from '@testing-library/react'
import '@testing-library/jest-dom'
import { RetryImg } from '../../components/RetryImg'

describe('RetryImg', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  test('renders a plain img pointed at src', () => {
    render(<RetryImg src="/api/v1/files/f1/preview" alt="photo" />)
    const img = screen.getByAltText('photo') as HTMLImageElement
    expect(img.src).toContain('/api/v1/files/f1/preview')
  })

  test('retries with a cache-busted src after a rate-limited (onError) load, with backoff', async () => {
    render(<RetryImg src="/api/v1/files/f1/preview" alt="photo" />)
    const img = () => screen.getByAltText('photo') as HTMLImageElement

    fireEvent.error(img())
    // Not retried yet — still mid-backoff.
    expect(img().src).toContain('/preview')
    expect(img().src).not.toContain('retry=')

    await act(async () => { await jest.advanceTimersByTimeAsync(1000) })
    expect(img().src).toContain('retry=1')
  })

  test('gives up and shows a broken-image placeholder after repeated failures', async () => {
    render(<RetryImg src="/api/v1/files/f1/preview" alt="photo" />)

    // Exhaust every retry attempt.
    for (let i = 0; i < 5; i++) {
      fireEvent.error(screen.getByAltText('photo'))
      await act(async () => { await jest.advanceTimersByTimeAsync(15_000) })
    }

    expect(screen.queryByAltText('photo')).not.toBeInTheDocument()
  })

  test('resets and retries fresh when src changes', () => {
    const { rerender } = render(<RetryImg src="/api/v1/files/f1/preview" alt="photo" />)
    fireEvent.error(screen.getByAltText('photo'))

    rerender(<RetryImg src="/api/v1/files/f2/preview" alt="photo" />)
    const img = screen.getByAltText('photo') as HTMLImageElement
    expect(img.src).toContain('/api/v1/files/f2/preview')
    expect(img.src).not.toContain('retry=')
  })
})
