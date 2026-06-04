import React from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
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

import { Route } from '../../routes/math-game'

const Page = Route.options.component as React.ComponentType

beforeEach(() => {
  mockAuth = { user: null, isAuthenticated: false }
  localStorage.clear()
  jest.useRealTimers()
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
      screen.getByRole('heading', { name: /Radiation Therapy Math Test/i, level: 1 }),
    ).toBeInTheDocument()
  })

  test('renders the reference article mentioning Varian', () => {
    render(<Page />)
    expect(screen.getByText(/Why mental math matters in radiation therapy/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Learn more about Varian/i })).toHaveAttribute(
      'href',
      'https://www.varian.com/',
    )
  })

  test('shows the start screen with the rules', () => {
    render(<Page />)
    expect(screen.getByRole('button', { name: /start test/i })).toBeInTheDocument()
    expect(screen.getByText(/10 seconds per question/i)).toBeInTheDocument()
  })

  test('prompts anonymous users to sign in to track scores', () => {
    render(<Page />)
    expect(screen.getByRole('link', { name: /sign in/i })).toHaveAttribute('href', '/login')
    // No score-history section for signed-out users.
    expect(screen.queryByText(/your score history/i)).not.toBeInTheDocument()
  })

  test('starting the test shows the first question and timer', () => {
    render(<Page />)
    fireEvent.click(screen.getByRole('button', { name: /start test/i }))
    expect(screen.getByText(/Question 1 \/ 10/i)).toBeInTheDocument()
    expect(screen.getByText('10s')).toBeInTheDocument()
    expect(screen.getByLabelText('Your answer')).toBeInTheDocument()
  })

  test('answering all questions reaches the completion screen', () => {
    render(<Page />)
    fireEvent.click(screen.getByRole('button', { name: /start test/i }))
    answerAll('0')
    expect(screen.getByRole('heading', { name: /test complete/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /play again/i })).toBeInTheDocument()
  })

  test('a timed-out question auto-advances when the clock hits zero', () => {
    jest.useFakeTimers()
    render(<Page />)
    fireEvent.click(screen.getByRole('button', { name: /start test/i }))
    expect(screen.getByText(/Question 1 \/ 10/i)).toBeInTheDocument()
    act(() => {
      jest.advanceTimersByTime(10_000)
    })
    expect(screen.getByText(/Question 2 \/ 10/i)).toBeInTheDocument()
  })

  test('signed-in users see a score history that records a finished game', () => {
    mockAuth = { user: { username: 'tester' }, isAuthenticated: true }
    render(<Page />)
    expect(screen.getByText(/your score history/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /start test/i }))
    answerAll('0')

    // Completion screen confirms the save, and an attempt is persisted per-user.
    expect(screen.getByText(/saved to your score history/i)).toBeInTheDocument()
    const stored = JSON.parse(localStorage.getItem('apollo_math_game_scores_tester') || '[]')
    expect(stored).toHaveLength(1)
    expect(stored[0].total).toBe(10)
  })
})
