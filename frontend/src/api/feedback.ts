import { post } from './client'
import type { Feedback, FeedbackCategory } from '../types/api'

export function submitFeedback(category: FeedbackCategory, message: string) {
  return post<Feedback>('/feedback', { category, message })
}
