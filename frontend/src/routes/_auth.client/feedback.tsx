import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { MdArrowBack, MdCheck, MdFeedback } from 'react-icons/md'
import { submitFeedback } from '../../api/feedback'
import { ApiError } from '../../api/client'
import { meQueryOptions } from '../../api/me'
import { FEEDBACK_CATEGORIES, type FeedbackCategory } from '../../types/api'

export const Route = createFileRoute('/_auth/client/feedback')({
  component: RouteComponent,
})

const MAX_MESSAGE_LEN = 5000

function RouteComponent() {
  const navigate = useNavigate()
  const { data: me, isLoading: meLoading } = useQuery(meQueryOptions)

  const [category, setCategory] = useState<FeedbackCategory>('general')
  const [message, setMessage] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  if (meLoading) return <p className="text-sm text-gray-500">Loading…</p>

  if (me && !me.feedback_access_enabled) {
    return (
      <div className="max-w-lg mx-auto">
        <div className="bg-white border border-gray-200 rounded-xl px-6 py-8 flex flex-col items-center text-center gap-3">
          <MdFeedback className="text-5xl text-gray-300" />
          <h2 className="text-lg font-semibold text-gray-900 m-0">Feedback isn&rsquo;t available yet</h2>
          <p className="text-sm text-gray-500 m-0">This account doesn&rsquo;t have access to the feedback form.</p>
          <button
            onClick={() => navigate({ to: '/client/profile' })}
            className="px-5 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium cursor-pointer transition-colors mt-2"
          >
            Back to profile
          </button>
        </div>
      </div>
    )
  }

  const mutation = useMutation({
    mutationFn: () => submitFeedback(category, message.trim()),
    onSuccess: () => {
      setDone(true)
      setError(null)
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Failed to submit feedback'),
  })

  if (done) {
    return (
      <div className="max-w-lg mx-auto">
        <div className="bg-white border border-gray-200 rounded-xl px-6 py-8 flex flex-col items-center text-center gap-3">
          <MdCheck className="text-5xl text-green-500" />
          <h2 className="text-lg font-semibold text-gray-900 m-0">Thanks for the feedback</h2>
          <p className="text-sm text-gray-500 m-0">We've received your submission and will take a look.</p>
          <div className="flex items-center gap-3 mt-2">
            <button
              onClick={() => { setDone(false); setMessage(''); setCategory('general') }}
              className="px-4 py-2 text-sm border border-gray-200 rounded-lg text-gray-700 hover:bg-gray-50 cursor-pointer transition-colors"
            >
              Send another
            </button>
            <button
              onClick={() => navigate({ to: '/client/profile' })}
              className="px-5 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium cursor-pointer transition-colors"
            >
              Back to profile
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-lg mx-auto space-y-4">
      <button
        onClick={() => navigate({ to: '/client/profile' })}
        className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 cursor-pointer bg-transparent border-0 p-0 transition-colors"
      >
        <MdArrowBack className="text-base" /> Back to profile
      </button>

      <h2 className="text-lg font-semibold text-gray-900 m-0">Send feedback</h2>

      <div className="bg-white border border-gray-200 rounded-xl px-5 py-4">
        <div className="flex items-start gap-3 mb-4 pb-4 border-b border-gray-100">
          <div className="w-9 h-9 rounded-lg bg-blue-50 flex items-center justify-center shrink-0">
            <MdFeedback className="text-blue-600 text-lg" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-gray-800 m-0">Tell us what's on your mind</h3>
            <p className="text-xs text-gray-500 m-0 mt-0.5">
              Report a bug, request a feature, or share general feedback. An admin will review it.
            </p>
          </div>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            setError(null)
            mutation.mutate()
          }}
          className="flex flex-col gap-3"
        >
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500">Category</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as FeedbackCategory)}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent cursor-pointer"
            >
              {(Object.entries(FEEDBACK_CATEGORIES) as [FeedbackCategory, string][]).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <label className="text-xs text-gray-500">Message</label>
              <span className="text-xs text-gray-400">{message.length}/{MAX_MESSAGE_LEN}</span>
            </div>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              required
              minLength={1}
              maxLength={MAX_MESSAGE_LEN}
              rows={6}
              placeholder="What happened, or what would you like to see?"
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
            />
          </div>

          {error && <p className="text-xs text-red-500 m-0">{error}</p>}

          <button
            type="submit"
            disabled={!message.trim() || mutation.isPending}
            className="self-start px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg disabled:opacity-50 transition-colors cursor-pointer"
          >
            {mutation.isPending ? 'Sending…' : 'Send feedback'}
          </button>
        </form>
      </div>
    </div>
  )
}
