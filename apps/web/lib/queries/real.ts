import { cache } from 'react'
import type { BinanceEnv, RealGate, RealStatus } from '@sereno/shared'
import { db, repos } from '../db'
import { canCreateReal, readinessView, type Readiness, type ReadinessView } from '../real-readiness'
import { databaseNow } from './sql/clock'
import { countOpenPositions } from './sql/open-positions'

// Ajustes › Plata real (spec real §Dashboard): los chequeos que guardó el bot, la sesión
// real activa con lo que puede hacer, y si se puede crear una. Todo sale de la base.

export interface RealSessionView {
  id: string
  status: RealStatus
  capital: number
  /** Fracción del capital que puede perder antes de cerrar todo y apagarse (`risk.lossCap`). */
  lossCap: number
  env: BinanceEnv
  /** Lo que el bot informó en su latido; null si todavía no lo escribió. */
  gate: RealGate | null
  /** Con abiertas no se archiva, así que tampoco se puede empezar otra. */
  openPositions: number
}

export interface RealPanel {
  readiness: ReadinessView | null
  session: RealSessionView | null
  canCreate: Readiness
}

export const getRealPanel = cache(async (): Promise<RealPanel> => {
  const [row, real, now] = await Promise.all([repos.realReadiness.latest(), repos.sessions.getActive('live'), databaseNow(db)])
  const readiness = row ? readinessView(row, now) : null
  let session: RealSessionView | null = null
  if (real?.realStatus && real.binanceEnv) {
    const [bot, settings, openPositions] = await Promise.all([repos.bot.get(real.id), repos.settings.get(real.id), countOpenPositions(db, real.id)])
    session = {
      id: real.id,
      status: real.realStatus,
      capital: real.capitalInicial,
      lossCap: (settings?.config ?? real.settingsSnapshot).risk.lossCap,
      env: real.binanceEnv,
      gate: bot?.real ?? null,
      openPositions,
    }
  }
  return { readiness, session, canCreate: canCreateReal(readiness, session) }
})
