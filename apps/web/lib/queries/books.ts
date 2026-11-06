import { cache } from 'react'
import type { LearningState } from '@sereno/core'
import { initialLearningState } from '@sereno/core/src/learning/state'
import type { ClosedPositionRecord } from '@sereno/db'
import { db, repos } from '../db'
import { loadLive } from './live'
import type { LivePayload } from '../live/types'
import { maxDrawdown, type DrawdownView } from './sql/equity'

// Lecturas que comparten varias pantallas, una vez por pedido (`cache` de React).

export interface Books {
  /** Cerradas reales, las más recientes primero. */
  real: ClosedPositionRecord[]
  /** Cerradas de la cartera sombra (spec §8), aparte: nunca se mezclan en una estadística. */
  shadow: ClosedPositionRecord[]
  drawdown: DrawdownView
}

export const getBooks = cache(async (sessionId: string): Promise<Books> => {
  const [real, shadow, drawdown] = await Promise.all([
    repos.positions.listClosed(sessionId),
    repos.positions.listClosed(sessionId, { shadow: true }),
    maxDrawdown(db, sessionId),
  ])
  return { real: real.items, shadow: shadow.items, drawdown }
})

/** El payload en vivo como lo vería `/api/live` ahora: el dato inicial de `LiveProvider`. */
export const getLive = cache(async (sessionId: string): Promise<LivePayload | null> => {
  const live = await loadLive(sessionId)
  return live && 'unchanged' in live ? null : live
})

export interface LearningView {
  state: LearningState
  /** La sesión todavía no aprendió nada: `state` es el inicial. */
  initial: boolean
}

export const getLearning = cache(async (sessionId: string, startedAt: number): Promise<LearningView> => {
  const state = await repos.learning.get(sessionId)
  return state ? { state, initial: false } : { state: initialLearningState(startedAt), initial: true }
})
