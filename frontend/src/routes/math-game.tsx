import { createFileRoute, Link } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { MdTimer, MdCheck, MdClose, MdEmojiEvents, MdLock, MdReplay, MdSchool, MdStop } from 'react-icons/md'
import { useAuth } from '../auth'
import { listMathScores, saveMathScore } from '../api/mathGame'
import type { MathGameScore } from '../types/api'

export const Route = createFileRoute('/math-game')({
  component: RouteComponent,
})

// ── Game configuration ────────────────────────────────────────────────────────

const QUESTIONS_PER_GAME = 10
const SECONDS_PER_QUESTION = 15
const MAX_STORED_ATTEMPTS = 20

type Operator = '+' | '-'

interface Question {
  a: number
  b: number
  op: Operator
  answer: number
}

interface AnswerRecord {
  given: number | null
  correct: boolean
  timedOut: boolean
}

interface PracticeRecord {
  question: Question
  given: number | null
  correct: boolean
  timeMs: number
}

interface Attempt {
  date: string
  score: number
  total: number
  durationMs: number
}

type Phase = 'idle' | 'playing' | 'done' | 'practice' | 'practice-done'

// ── Question generation (mod-1000 looping scale) ──────────────────────────────
//
// Numbers live on a 0.0–999.9 loop. Adding past 999.9 wraps back to 0.0;
// subtracting below 0.0 wraps to 999.9. All arithmetic is done in integer
// tenths to keep the stored answer free of floating-point drift.

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function buildQuestion(): Question {
  const op: Operator = Math.random() < 0.5 ? '+' : '-'
  const aTenths = randInt(0, 9999)   // 0.0–999.9
  const bTenths = randInt(50, 300)   // 5.0–30.0, small operand for mental math
  const a = aTenths / 10
  const b = bTenths / 10
  const MODULUS = 10000
  const answerTenths =
    op === '+'
      ? (aTenths + bTenths) % MODULUS
      : ((aTenths - bTenths) % MODULUS + MODULUS) % MODULUS
  return { a, b, op, answer: answerTenths / 10 }
}

function buildGame(): Question[] {
  return Array.from({ length: QUESTIONS_PER_GAME }, buildQuestion)
}

// ── Score persistence ─────────────────────────────────────────────────────────
//
// Signed-in users persist to the backend (math_game_scores table) so their
// history follows their account. Anonymous players are tracked client-side in
// sessionStorage — kept for the browser session only, never sent to the server.

const ANON_STORAGE_KEY = 'apollo_math_game_scores_anon'

function toAttempt(s: MathGameScore): Attempt {
  return { date: s.created_at, score: s.score, total: s.total, durationMs: s.duration_ms }
}

function loadAnonAttempts(): Attempt[] {
  try {
    const raw = sessionStorage.getItem(ANON_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as Attempt[]) : []
  } catch {
    return []
  }
}

function saveAnonAttempt(attempt: Attempt): Attempt[] {
  const next = [attempt, ...loadAnonAttempts()].slice(0, MAX_STORED_ATTEMPTS)
  try {
    sessionStorage.setItem(ANON_STORAGE_KEY, JSON.stringify(next))
  } catch {
    /* ignore quota / unavailable storage */
  }
  return next
}

// ── Component ─────────────────────────────────────────────────────────────────

function RouteComponent() {
  const { user, isAuthenticated } = useAuth()
  const username = user?.username ?? null

  // Timed-test state
  const [phase, setPhase] = useState<Phase>('idle')
  const [questions, setQuestions] = useState<Question[]>([])
  const [current, setCurrent] = useState(0)
  const [answers, setAnswers] = useState<AnswerRecord[]>([])
  const [input, setInput] = useState('')
  const [timeLeft, setTimeLeft] = useState(SECONDS_PER_QUESTION)
  const [attempts, setAttempts] = useState<Attempt[]>([])

  const startRef = useRef(0)
  const savedRef = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Practice state
  const [practiceQuestion, setPracticeQuestion] = useState<Question | null>(null)
  const [practiceRecords, setPracticeRecords] = useState<PracticeRecord[]>([])
  const [practiceInput, setPracticeInput] = useState('')
  const practiceQuestionStartRef = useRef(0)
  const practiceInputRef = useRef<HTMLInputElement>(null)

  // Load history: backend for signed-in users, sessionStorage for anonymous.
  useEffect(() => {
    if (isAuthenticated) {
      let cancelled = false
      listMathScores()
        .then((scores) => {
          if (!cancelled) setAttempts(scores.map(toAttempt))
        })
        .catch(() => {
          if (!cancelled) setAttempts([])
        })
      return () => {
        cancelled = true
      }
    }
    setAttempts(loadAnonAttempts())
  }, [isAuthenticated, username])

  const startGame = useCallback(() => {
    setQuestions(buildGame())
    setAnswers([])
    setCurrent(0)
    setInput('')
    setTimeLeft(SECONDS_PER_QUESTION)
    startRef.current = Date.now()
    savedRef.current = false
    setPhase('playing')
  }, [])

  const startPractice = useCallback(() => {
    setPracticeQuestion(buildQuestion())
    setPracticeRecords([])
    setPracticeInput('')
    practiceQuestionStartRef.current = Date.now()
    setPhase('practice')
  }, [])

  const submitAnswer = useCallback(
    (value: number | null, timedOut: boolean) => {
      setAnswers((prev) => {
        const q = questions[prev.length]
        const correct = value !== null && value === q.answer
        return [...prev, { given: value, correct, timedOut }]
      })
      setInput('')
      setCurrent((c) => {
        const next = c + 1
        if (next >= QUESTIONS_PER_GAME) {
          setPhase('done')
        }
        return next
      })
    },
    [questions],
  )

  const handleSubmit = useCallback(
    (e?: React.FormEvent) => {
      e?.preventDefault()
      if (phase !== 'playing') return
      const trimmed = input.trim()
      const parsed = trimmed === '' ? null : Number(trimmed)
      submitAnswer(parsed === null || Number.isNaN(parsed) ? null : parsed, false)
    },
    [input, phase, submitAnswer],
  )

  const submitPracticeAnswer = useCallback(
    (e?: React.FormEvent) => {
      e?.preventDefault()
      if (phase !== 'practice' || !practiceQuestion) return
      const trimmed = practiceInput.trim()
      const parsed = trimmed === '' ? null : Number(trimmed)
      const given = parsed === null || Number.isNaN(parsed) ? null : parsed
      const correct = given !== null && given === practiceQuestion.answer
      const timeMs = Date.now() - practiceQuestionStartRef.current
      setPracticeRecords((prev) => [...prev, { question: practiceQuestion, given, correct, timeMs }])
      setPracticeInput('')
      setPracticeQuestion(buildQuestion())
      practiceQuestionStartRef.current = Date.now()
    },
    [phase, practiceQuestion, practiceInput],
  )

  const stopPractice = useCallback(() => {
    setPhase('practice-done')
  }, [])

  // Countdown timer: resets each question, advances on timeout.
  useEffect(() => {
    if (phase !== 'playing') return
    setTimeLeft(SECONDS_PER_QUESTION)
    inputRef.current?.focus()
    const id = setInterval(() => {
      setTimeLeft((t) => {
        if (t <= 1) {
          clearInterval(id)
          return 0
        }
        return t - 1
      })
    }, 1000)
    return () => clearInterval(id)
  }, [phase, current])

  useEffect(() => {
    if (phase === 'playing' && timeLeft === 0) {
      submitAnswer(null, true)
    }
  }, [phase, timeLeft, submitAnswer])

  // Focus practice input whenever a new question arrives.
  useEffect(() => {
    if (phase === 'practice') {
      practiceInputRef.current?.focus()
    }
  }, [phase, practiceQuestion])

  const score = answers.filter((a) => a.correct).length

  // Persist the finished timed test (guard against StrictMode double-run).
  useEffect(() => {
    if (phase !== 'done' || savedRef.current) return
    savedRef.current = true
    const attempt: Attempt = {
      date: new Date().toISOString(),
      score,
      total: QUESTIONS_PER_GAME,
      durationMs: Date.now() - startRef.current,
    }
    if (isAuthenticated) {
      saveMathScore({ score, total: QUESTIONS_PER_GAME, duration_ms: attempt.durationMs })
        .then((saved) => setAttempts((prev) => [toAttempt(saved), ...prev]))
        .catch(() => setAttempts((prev) => [attempt, ...prev]))
      return
    }
    setAttempts(saveAnonAttempt(attempt))
  }, [phase, score, isAuthenticated])

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      {/* Hero */}
      <section className="bg-white border-b border-gray-200">
        <div className="max-w-3xl mx-auto px-6 py-12">
          <span className="text-xs font-semibold uppercase tracking-widest text-blue-600">
            Mental Math Challenge
          </span>
          <h1 className="text-3xl font-bold text-gray-900 mt-2 mb-3">Radiation Therapy Math Test</h1>
          <p className="text-gray-500 text-sm leading-relaxed max-w-xl">
            A timed addition and subtraction drill on a mod-1000 looping scale — numbers wrap around
            from 999.9 back to 0.0. Answer {QUESTIONS_PER_GAME} questions, with just{' '}
            {SECONDS_PER_QUESTION} seconds on the clock for each one.
          </p>
        </div>
      </section>

      <div className="max-w-3xl mx-auto px-6 pt-10 space-y-8">
        {/* Game card */}
        <section className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          {phase === 'idle' && (
            <StartScreen onStart={startGame} onPractice={startPractice} isAuthenticated={isAuthenticated} />
          )}
          {phase === 'playing' && (
            <PlayScreen
              question={questions[current]}
              index={current}
              timeLeft={timeLeft}
              input={input}
              setInput={setInput}
              onSubmit={handleSubmit}
              inputRef={inputRef}
            />
          )}
          {phase === 'done' && (
            <DoneScreen
              score={score}
              answers={answers}
              questions={questions}
              durationMs={Date.now() - startRef.current}
              onPlayAgain={startGame}
              isAuthenticated={isAuthenticated}
            />
          )}
          {phase === 'practice' && practiceQuestion && (
            <PracticeScreen
              question={practiceQuestion}
              records={practiceRecords}
              input={practiceInput}
              setInput={setPracticeInput}
              onSubmit={submitPracticeAnswer}
              onStop={stopPractice}
              inputRef={practiceInputRef}
            />
          )}
          {phase === 'practice-done' && (
            <PracticeDoneScreen
              records={practiceRecords}
              onBack={() => setPhase('idle')}
              onPracticeAgain={startPractice}
            />
          )}
        </section>

        {/* Score history — timed test only */}
        {(phase === 'idle' || phase === 'done') && (
          <ScoreHistory attempts={attempts} isAuthenticated={isAuthenticated} />
        )}

        {/* Reference article */}
        <ReferenceArticle />
      </div>
    </div>
  )
}

// ── Start screen ──────────────────────────────────────────────────────────────

function StartScreen({
  onStart,
  onPractice,
  isAuthenticated,
}: {
  onStart: () => void
  onPractice: () => void
  isAuthenticated: boolean
}) {
  return (
    <div className="px-8 py-10 text-center">
      <div className="w-12 h-12 rounded-xl bg-blue-50 flex items-center justify-center mx-auto mb-4">
        <MdTimer className="text-blue-600 text-2xl" />
      </div>
      <h2 className="text-lg font-bold text-gray-900 mb-2">Ready to test your speed?</h2>
      <ul className="text-sm text-gray-500 leading-relaxed max-w-sm mx-auto mb-6 space-y-1">
        <li>{QUESTIONS_PER_GAME} addition &amp; subtraction questions</li>
        <li>{SECONDS_PER_QUESTION} seconds per question</li>
        <li>Numbers wrap around at 1000 (mod-1000 scale)</li>
        <li>No going back — answer or the clock moves on</li>
      </ul>
      <div className="flex items-center justify-center gap-3 flex-wrap">
        <button
          onClick={onStart}
          className="inline-block px-8 py-3 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-xl transition-colors shadow-sm"
        >
          Start test
        </button>
        <button
          onClick={onPractice}
          className="inline-flex items-center gap-2 px-6 py-3 bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm font-semibold rounded-xl transition-colors"
        >
          <MdSchool className="text-base" />
          Practice
        </button>
      </div>
      {!isAuthenticated && (
        <p className="mt-5 text-xs text-gray-400 flex items-center justify-center gap-1.5">
          <MdLock className="text-sm" />
          <span>
            <Link to="/login" className="text-blue-600 hover:text-blue-800 no-underline">
              Sign in
            </Link>{' '}
            to save your test scores to your account — otherwise they are kept only
            for this browser session.
          </span>
        </p>
      )}
    </div>
  )
}

// ── Play screen ───────────────────────────────────────────────────────────────

function PlayScreen({
  question,
  index,
  timeLeft,
  input,
  setInput,
  onSubmit,
  inputRef,
}: {
  question: Question
  index: number
  timeLeft: number
  input: string
  setInput: (v: string) => void
  onSubmit: (e?: React.FormEvent) => void
  inputRef: React.RefObject<HTMLInputElement>
}) {
  const lowTime = timeLeft <= 3
  return (
    <div className="px-8 py-8">
      {/* Progress + timer */}
      <div className="flex items-center justify-between mb-6">
        <span className="text-xs font-semibold uppercase tracking-widest text-gray-400">
          Question {index + 1} / {QUESTIONS_PER_GAME}
        </span>
        <span
          className={`inline-flex items-center gap-1.5 text-sm font-semibold tabular-nums ${
            lowTime ? 'text-red-600' : 'text-gray-600'
          }`}
        >
          <MdTimer className="text-base" />
          {timeLeft}s
        </span>
      </div>

      {/* Progress bar */}
      <div className="h-1.5 w-full bg-gray-100 rounded-full overflow-hidden mb-8">
        <div
          className={`h-full rounded-full transition-all duration-1000 ease-linear ${
            lowTime ? 'bg-red-500' : 'bg-blue-500'
          }`}
          style={{ width: `${(timeLeft / SECONDS_PER_QUESTION) * 100}%` }}
        />
      </div>

      {/* Question */}
      <div className="text-center mb-8">
        <span className="text-4xl font-bold text-gray-900 tabular-nums">
          {question.a} {question.op} {question.b}
        </span>
      </div>

      <form onSubmit={onSubmit} className="flex flex-col items-center gap-4">
        <input
          ref={inputRef}
          type="number"
          inputMode="decimal"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          autoFocus
          aria-label="Your answer"
          placeholder="Your answer"
          className="w-48 text-center text-2xl font-semibold tabular-nums px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        />
        <button
          type="submit"
          className="px-8 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-xl transition-colors"
        >
          Submit
        </button>
      </form>
    </div>
  )
}

// ── Practice screen ───────────────────────────────────────────────────────────

function PracticeScreen({
  question,
  records,
  input,
  setInput,
  onSubmit,
  onStop,
  inputRef,
}: {
  question: Question
  records: PracticeRecord[]
  input: string
  setInput: (v: string) => void
  onSubmit: (e?: React.FormEvent) => void
  onStop: () => void
  inputRef: React.RefObject<HTMLInputElement>
}) {
  const correct = records.filter((r) => r.correct).length
  const total = records.length
  const lastFive = records.slice(-5).reverse()

  return (
    <div className="px-8 py-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <span className="text-xs font-semibold uppercase tracking-widest text-purple-600">
            Practice Mode
          </span>
          {total > 0 && (
            <p className="text-xs text-gray-400 mt-0.5 tabular-nums">
              {correct} / {total} correct
            </p>
          )}
        </div>
        <button
          onClick={onStop}
          className="inline-flex items-center gap-1.5 px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 text-xs font-semibold rounded-xl transition-colors"
        >
          <MdStop className="text-sm" />
          Stop
        </button>
      </div>

      {/* Question */}
      <div className="text-center mb-8">
        <span className="text-4xl font-bold text-gray-900 tabular-nums">
          {question.a} {question.op} {question.b}
        </span>
      </div>

      <form onSubmit={onSubmit} className="flex flex-col items-center gap-4 mb-8">
        <input
          ref={inputRef}
          type="number"
          inputMode="decimal"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          autoFocus
          aria-label="Your answer"
          placeholder="Your answer"
          className="w-48 text-center text-2xl font-semibold tabular-nums px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
        />
        <button
          type="submit"
          className="px-8 py-2.5 bg-purple-600 hover:bg-purple-700 text-white text-sm font-semibold rounded-xl transition-colors"
        >
          Submit
        </button>
      </form>

      {/* Recent answers */}
      {lastFive.length > 0 && (
        <div className="border border-gray-100 rounded-xl divide-y divide-gray-100">
          {lastFive.map((r, i) => (
            <div key={i} className="flex items-center justify-between px-4 py-2 text-xs">
              <span className="text-gray-500 tabular-nums">
                {r.question.a} {r.question.op} {r.question.b} = {r.question.answer}
              </span>
              <div className="flex items-center gap-3">
                <span className="text-gray-400 tabular-nums">{(r.timeMs / 1000).toFixed(1)}s</span>
                <span className={`flex items-center ${r.correct ? 'text-green-600' : 'text-red-600'}`}>
                  {r.correct ? <MdCheck /> : <MdClose />}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Practice done screen ──────────────────────────────────────────────────────

function PracticeDoneScreen({
  records,
  onBack,
  onPracticeAgain,
}: {
  records: PracticeRecord[]
  onBack: () => void
  onPracticeAgain: () => void
}) {
  const correct = records.filter((r) => r.correct).length
  const total = records.length
  const avgMs = total > 0 ? records.reduce((s, r) => s + r.timeMs, 0) / total : 0

  return (
    <div className="px-8 py-10">
      <div className="text-center mb-8">
        <div className="w-12 h-12 rounded-xl bg-purple-50 flex items-center justify-center mx-auto mb-4">
          <MdSchool className="text-purple-600 text-2xl" />
        </div>
        <h2 className="text-lg font-bold text-gray-900 mb-1">Practice session complete</h2>
        {total === 0 ? (
          <p className="text-sm text-gray-400 mt-2">No questions answered.</p>
        ) : (
          <>
            <p className="text-4xl font-bold text-gray-900 my-3 tabular-nums">
              {correct}
              <span className="text-2xl text-gray-400"> / {total}</span>
            </p>
            <p className="text-sm text-gray-500">
              {Math.round((correct / total) * 100)}% correct · avg{' '}
              {(avgMs / 1000).toFixed(1)}s per question
            </p>
          </>
        )}
      </div>

      {/* Per-question breakdown */}
      {total > 0 && (
        <div className="border border-gray-200 rounded-xl divide-y divide-gray-100 mb-8 max-h-72 overflow-y-auto">
          {records.map((r, i) => (
            <div key={i} className="flex items-center justify-between px-4 py-2.5 text-sm">
              <span className="text-gray-600 tabular-nums">
                {r.question.a} {r.question.op} {r.question.b} = {r.question.answer}
              </span>
              <div className="flex items-center gap-4">
                <span className="text-xs text-gray-400 tabular-nums">
                  {(r.timeMs / 1000).toFixed(1)}s
                </span>
                <span
                  className={`inline-flex items-center gap-1 font-medium ${
                    r.correct ? 'text-green-600' : 'text-red-600'
                  }`}
                >
                  {r.correct ? (
                    <>
                      <MdCheck /> Correct
                    </>
                  ) : (
                    <>
                      <MdClose />
                      {r.given === null ? 'Skipped' : `You: ${r.given}`}
                    </>
                  )}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center justify-center gap-3 flex-wrap">
        <button
          onClick={onPracticeAgain}
          className="inline-flex items-center gap-2 px-8 py-3 bg-purple-600 hover:bg-purple-700 text-white text-sm font-semibold rounded-xl transition-colors shadow-sm"
        >
          <MdReplay /> Practice again
        </button>
        <button
          onClick={onBack}
          className="px-6 py-3 bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm font-semibold rounded-xl transition-colors"
        >
          Back to menu
        </button>
      </div>
    </div>
  )
}

// ── Done screen ───────────────────────────────────────────────────────────────

function DoneScreen({
  score,
  answers,
  questions,
  durationMs,
  onPlayAgain,
  isAuthenticated,
}: {
  score: number
  answers: AnswerRecord[]
  questions: Question[]
  durationMs: number
  onPlayAgain: () => void
  isAuthenticated: boolean
}) {
  const pct = Math.round((score / QUESTIONS_PER_GAME) * 100)
  return (
    <div className="px-8 py-10">
      <div className="text-center mb-8">
        <div className="w-12 h-12 rounded-xl bg-blue-50 flex items-center justify-center mx-auto mb-4">
          <MdEmojiEvents className="text-blue-600 text-2xl" />
        </div>
        <h2 className="text-lg font-bold text-gray-900 mb-1">Test complete</h2>
        <p className="text-4xl font-bold text-gray-900 my-3 tabular-nums">
          {score}
          <span className="text-2xl text-gray-400"> / {QUESTIONS_PER_GAME}</span>
        </p>
        <p className="text-sm text-gray-500">
          {pct}% correct · finished in {(durationMs / 1000).toFixed(1)}s
        </p>
        <p className="text-xs text-green-600 mt-2">
          {isAuthenticated
            ? 'Saved to your account.'
            : 'Saved for this browser session.'}
        </p>
      </div>

      {/* Per-question review */}
      <div className="border border-gray-200 rounded-xl divide-y divide-gray-100 mb-8">
        {questions.map((q, i) => {
          const ans = answers[i]
          const ok = ans?.correct
          return (
            <div key={i} className="flex items-center justify-between px-4 py-2.5 text-sm">
              <span className="text-gray-600 tabular-nums">
                {q.a} {q.op} {q.b} = {q.answer}
              </span>
              <span
                className={`inline-flex items-center gap-1.5 font-medium ${
                  ok ? 'text-green-600' : 'text-red-600'
                }`}
              >
                {ok ? (
                  <>
                    <MdCheck /> Correct
                  </>
                ) : (
                  <>
                    <MdClose />
                    {ans?.timedOut
                      ? 'Timed out'
                      : ans?.given === null || ans?.given === undefined
                        ? 'Skipped'
                        : `You: ${ans.given}`}
                  </>
                )}
              </span>
            </div>
          )
        })}
      </div>

      <div className="text-center">
        <button
          onClick={onPlayAgain}
          className="inline-flex items-center gap-2 px-8 py-3 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-xl transition-colors shadow-sm"
        >
          <MdReplay /> Play again
        </button>
      </div>
    </div>
  )
}

// ── Score history ─────────────────────────────────────────────────────────────

function ScoreHistory({
  attempts,
  isAuthenticated,
}: {
  attempts: Attempt[]
  isAuthenticated: boolean
}) {
  const best = attempts.reduce((m, a) => Math.max(m, a.score), 0)
  return (
    <section className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-6 py-4 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">Your score history</h3>
          <p className="text-xs text-gray-400 mt-0.5">
            {isAuthenticated ? 'Saved to your account' : 'This browser session only'}
          </p>
        </div>
        {attempts.length > 0 && (
          <span className="text-xs font-medium text-blue-600">
            Best: {best} / {QUESTIONS_PER_GAME}
          </span>
        )}
      </div>
      <div className="h-px bg-gray-100" />
      {attempts.length === 0 ? (
        <p className="px-6 py-6 text-sm text-gray-400 text-center">
          No attempts yet — finish a test to record your first score.
        </p>
      ) : (
        <div className="divide-y divide-gray-100">
          {attempts.map((a, i) => (
            <div key={i} className="flex items-center justify-between px-6 py-3 text-sm">
              <span className="text-gray-500">
                {new Date(a.date).toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
              <div className="flex items-center gap-4">
                <span className="text-xs text-gray-400 tabular-nums">
                  {(a.durationMs / 1000).toFixed(1)}s
                </span>
                <span className="font-semibold text-gray-900 tabular-nums">
                  {a.score} / {a.total}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

// ── Reference article ─────────────────────────────────────────────────────────

function ReferenceArticle() {
  return (
    <section className="bg-white rounded-xl border border-gray-200 px-8 py-8">
      <span className="text-xs font-semibold uppercase tracking-widest text-blue-600">
        Reference
      </span>
      <h2 className="text-xl font-bold text-gray-900 mt-2 mb-3">
        Why mental math matters in radiation therapy
      </h2>
      <p className="text-sm text-gray-500 leading-relaxed max-w-2xl mb-3">
        Radiation therapists and medical dosimetrists working with treatment systems — such as
        those built by Varian, a leading manufacturer of radiation oncology equipment — routinely
        rely on quick mental arithmetic. Verifying monitor units, summing fraction doses, and
        sanity-checking treatment-plan numbers all demand fast, confident addition and subtraction.
        Because of this, timed mental-math screenings are a common part of training and hiring in
        the field.
      </p>
      <p className="text-sm text-gray-500 leading-relaxed max-w-2xl mb-4">
        This game is a lightweight homage to that drill: ten quick questions, a fifteen-second clock,
        and no calculator. It is built purely for practice and fun, and is not affiliated with or
        endorsed by Varian Medical Systems.
      </p>
      <a
        href="https://www.varian.com/"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium text-blue-600 bg-blue-50 rounded-full border border-blue-100 hover:bg-blue-100 transition-colors no-underline"
      >
        Learn more about Varian
      </a>
    </section>
  )
}
