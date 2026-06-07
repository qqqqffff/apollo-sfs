import React from 'react'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

jest.mock('@tanstack/react-router', () => {
  const R = require('react')
  return {
    createFileRoute: () => (opts: any) => ({ options: opts }),
    Link: ({ children, to, className }: any) =>
      R.createElement('a', { href: to, className }, children),
  }
})

let mockAuth: { user: { username: string } | null; isAuthenticated: boolean }
jest.mock('../../auth', () => ({
  useAuth: () => mockAuth,
}))

const mockListMathScores = jest.fn()
const mockSaveMathScore = jest.fn()
jest.mock('../../api/mathGame', () => ({
  listMathScores: (...args: any[]) => mockListMathScores(...args),
  saveMathScore: (...args: any[]) => mockSaveMathScore(...args),
}))

import { Route } from '../../routes/math-game'

const Page = Route.options.component as React.ComponentType

beforeEach(() => {
  mockAuth = { user: null, isAuthenticated: false }
  sessionStorage.clear()
  jest.useRealTimers()
  mockListMathScores.mockReset().mockResolvedValue([])
  mockSaveMathScore.mockReset().mockResolvedValue({
    id: 'abc',
    username: 'tester',
    score: 0,
    total: 10,
    duration_ms: 1000,
    created_at: new Date().toISOString(),
  })
})

// Plays through all 10 questions by repeatedly submitting an answer.
function answerAll(value = '0') {
  for (let i = 0; i < 10; i++) {
    const input = screen.getByLabelText('Your answer') as HTMLInputElement
    fireEvent.change(input, { target: { value } })
    fireEvent.click(screen.getByRole('button', { name: /submit/i }))
  }
}

describe('Math game page (/math-game)', () => {
  test('renders the hero heading', () => {
    render(<Page />)
    expect(
      screen.getByRole('heading', { name: /Math Test/i, level: 1 }),
    ).toBeInTheDocument()
  })

  test('shows the start screen with the rules, both mode buttons, and mod-1000 note', () => {
    render(<Page />)
    expect(screen.getByRole('button', { name: /start test/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /practice/i })).toBeInTheDocument()
    expect(screen.getByText(/15 seconds per question/i)).toBeInTheDocument()
    expect(screen.getByText(/numbers wrap around at 1000/i)).toBeInTheDocument()
  })

  test('prompts anonymous users to sign in but still shows a session history', () => {
    render(<Page />)
    expect(screen.getByRole('link', { name: /sign in/i })).toHaveAttribute('href', '/login')
    // Anonymous players get a session-scoped score history (sessionStorage).
    expect(screen.getByText(/your score history/i)).toBeInTheDocument()
    expect(screen.getByText(/this browser session only/i)).toBeInTheDocument()
    // The backend is never contacted for anonymous players.
    expect(mockListMathScores).not.toHaveBeenCalled()
  })

  test('anonymous scores are persisted to sessionStorage', () => {
    render(<Page />)
    fireEvent.click(screen.getByRole('button', { name: /start test/i }))
    answerAll('0')
    expect(screen.getByText(/saved for this browser session/i)).toBeInTheDocument()
    const stored = JSON.parse(sessionStorage.getItem('apollo_math_game_scores_anon') || '[]')
    expect(stored).toHaveLength(1)
    expect(stored[0].total).toBe(10)
    expect(mockSaveMathScore).not.toHaveBeenCalled()
  })

  test('starting the test shows the first question and 15-second timer', () => {
    render(<Page />)
    fireEvent.click(screen.getByRole('button', { name: /start test/i }))
    expect(screen.getByText(/Question 1 \/ 10/i)).toBeInTheDocument()
    expect(screen.getByText('15s')).toBeInTheDocument()
    expect(screen.getByLabelText('Your answer')).toBeInTheDocument()
  })

  test('answering all questions reaches the completion screen', () => {
    render(<Page />)
    fireEvent.click(screen.getByRole('button', { name: /start test/i }))
    answerAll('0')
    expect(screen.getByRole('heading', { name: /test complete/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /play again/i })).toBeInTheDocument()
  })

  test('a timed-out question auto-advances when the 15-second clock hits zero', () => {
    jest.useFakeTimers()
    render(<Page />)
    fireEvent.click(screen.getByRole('button', { name: /start test/i }))
    expect(screen.getByText(/Question 1 \/ 10/i)).toBeInTheDocument()
    act(() => {
      jest.advanceTimersByTime(15_000)
    })
    expect(screen.getByText(/Question 2 \/ 10/i)).toBeInTheDocument()
  })

  test('signed-in users load history from and save a finished game to the backend', async () => {
    mockAuth = { user: { username: 'tester' }, isAuthenticated: true }
    render(<Page />)

    // History is loaded from the backend on mount.
    await waitFor(() => expect(mockListMathScores).toHaveBeenCalled())
    expect(screen.getByText(/your score history/i)).toBeInTheDocument()
    expect(screen.getByText(/saved to your account/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /start test/i }))
    answerAll('0')

    // The finished game is POSTed to the backend with the right shape.
    await waitFor(() => expect(mockSaveMathScore).toHaveBeenCalledTimes(1))
    expect(mockSaveMathScore).toHaveBeenCalledWith(
      expect.objectContaining({ total: 10, score: expect.any(Number) }),
    )
    // Nothing is written to sessionStorage for signed-in users.
    expect(sessionStorage.getItem('apollo_math_game_scores_anon')).toBeNull()
  })
})

describe('Practice mode', () => {
  test('clicking Practice enters practice mode with a Stop button and no countdown', () => {
    render(<Page />)
    fireEvent.click(screen.getByRole('button', { name: /practice/i }))
    expect(screen.getByText(/practice mode/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument()
    expect(screen.getByLabelText('Your answer')).toBeInTheDocument()
    // No per-question countdown — elements whose full text is purely "NNs" shouldn't exist.
    expect(screen.queryByText(/^\d+s$/)).toBeNull()
  })

  test('answering a practice question records it and shows a running score', () => {
    render(<Page />)
    fireEvent.click(screen.getByRole('button', { name: /practice/i }))
    const input = screen.getByLabelText('Your answer') as HTMLInputElement
    fireEvent.change(input, { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: /submit/i }))
    // Running score appears (format: "x / 1 correct")
    expect(screen.getByText(/\/ 1 correct/i)).toBeInTheDocument()
    // Input is cleared for the next question
    expect(input.value).toBe('')
  })

  test('Stop button shows the practice-done summary screen', () => {
    render(<Page />)
    fireEvent.click(screen.getByRole('button', { name: /practice/i }))
    fireEvent.click(screen.getByRole('button', { name: /stop/i }))
    expect(screen.getByRole('heading', { name: /practice session complete/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /practice again/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /back to menu/i })).toBeInTheDocument()
  })

  test('practice summary shows score fraction and average time after answering', () => {
    render(<Page />)
    fireEvent.click(screen.getByRole('button', { name: /practice/i }))
    const input = screen.getByLabelText('Your answer') as HTMLInputElement
    fireEvent.change(input, { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: /submit/i }))
    fireEvent.click(screen.getByRole('button', { name: /stop/i }))
    // Score fraction (x / 1) and average time are shown
    expect(screen.getByText(/\/ 1/)).toBeInTheDocument()
    expect(screen.getByText(/avg/i)).toBeInTheDocument()
    // Per-question breakdown renders the answered question with "="
    expect(screen.getByText(/=/)).toBeInTheDocument()
  })

  test('Back to menu returns to the start screen', () => {
    render(<Page />)
    fireEvent.click(screen.getByRole('button', { name: /practice/i }))
    fireEvent.click(screen.getByRole('button', { name: /stop/i }))
    fireEvent.click(screen.getByRole('button', { name: /back to menu/i }))
    expect(screen.getByRole('button', { name: /start test/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /practice/i })).toBeInTheDocument()
  })

  test('Practice again restarts practice with a clean slate', () => {
    render(<Page />)
    fireEvent.click(screen.getByRole('button', { name: /practice/i }))
    // Answer one question so there is state to clear
    const input = screen.getByLabelText('Your answer') as HTMLInputElement
    fireEvent.change(input, { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: /submit/i }))
    fireEvent.click(screen.getByRole('button', { name: /stop/i }))
    fireEvent.click(screen.getByRole('button', { name: /practice again/i }))
    expect(screen.getByText(/practice mode/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument()
    // Records reset — running score not yet shown
    expect(screen.queryByText(/\/ \d+ correct/i)).toBeNull()
  })

  test('score history is hidden during practice and practice-done phases', () => {
    render(<Page />)
    // Visible on the idle start screen
    expect(screen.getByText(/your score history/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /practice/i }))
    expect(screen.queryByText(/your score history/i)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /stop/i }))
    expect(screen.queryByText(/your score history/i)).toBeNull()
  })
})
