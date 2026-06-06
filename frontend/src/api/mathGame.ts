import { get, post } from './client'
import type { MathGameScore } from '../types/api'

interface ListMathScoresResponse {
  scores: MathGameScore[]
}

export interface SaveMathScoreInput {
  score: number
  total: number
  duration_ms: number
}

// listMathScores returns the signed-in user's recent games, newest first.
export async function listMathScores(): Promise<MathGameScore[]> {
  const res = await get<ListMathScoresResponse>('/math-game/scores')
  return res.scores ?? []
}

// saveMathScore records one completed game for the signed-in user and returns
// the stored row.
export function saveMathScore(input: SaveMathScoreInput) {
  return post<MathGameScore>('/math-game/scores', input)
}
