import { useEffect, useState } from 'react'
import { MdClose } from 'react-icons/md'
import type { GuideStep } from '../data/onboardingGuides'

interface Props {
  // Small eyebrow label above the step title (e.g. "Getting started" or
  // "Premium features") so the modal reads clearly even mid-tour.
  eyebrow: string
  steps: GuideStep[]
  onClose: () => void
}

// OnboardingGuideModal is the shared stepped-tour shell for both the base
// and premium first-time guides — same dismiss/keyboard/scroll-lock
// behavior as the app's other modals (see ApiKeyGuideModal), plus a
// clickable step-dot trail so a step already visited can be revisited
// without stepping through everything in between.
export function OnboardingGuideModal({ eyebrow, steps, onClose }: Props) {
  const [step, setStep] = useState(0)
  const isLastStep = step === steps.length - 1

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [])

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-xl shadow-xl w-full max-w-lg flex flex-col max-h-[85vh]"
      >
        <div className="flex items-center justify-between gap-3 px-6 py-4 border-b border-gray-200 shrink-0">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-blue-600 uppercase tracking-wider m-0 mb-0.5">
              {eyebrow}
            </p>
            <h2 className="text-base font-semibold text-gray-900 m-0 truncate">
              {steps[step].title}
            </h2>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <button
              onClick={onClose}
              className="text-xs font-medium text-gray-400 hover:text-gray-600 cursor-pointer bg-transparent border-0 p-0 transition-colors"
            >
              Skip guide
            </button>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 transition-colors cursor-pointer bg-transparent border-0 p-1"
              aria-label="Close"
            >
              <MdClose className="text-xl" />
            </button>
          </div>
        </div>

        <div className="overflow-y-auto px-6 py-5 text-sm text-gray-700 leading-relaxed">
          <p className="text-xs text-gray-400 m-0 mb-3">
            Step {step + 1} of {steps.length}
          </p>
          {steps[step].body}
        </div>

        <div className="flex items-center justify-between px-6 py-4 border-t border-gray-200 shrink-0">
          <div className="flex items-center gap-1.5">
            {steps.map((_, i) => (
              <button
                key={i}
                onClick={() => setStep(i)}
                aria-label={`Go to step ${i + 1}`}
                aria-current={i === step}
                className={`w-1.5 h-1.5 rounded-full cursor-pointer border-0 p-0 transition-colors ${
                  i === step ? 'bg-blue-600' : 'bg-gray-200 hover:bg-gray-300'
                }`}
              />
            ))}
          </div>
          <div className="flex gap-2">
            {step > 0 && (
              <button
                onClick={() => setStep((s) => s - 1)}
                className="px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-lg border border-gray-200 cursor-pointer transition-colors"
              >
                Back
              </button>
            )}
            <button
              onClick={() => (isLastStep ? onClose() : setStep((s) => s + 1))}
              className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium cursor-pointer transition-colors"
            >
              {isLastStep ? 'Finish' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
