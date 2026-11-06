// Escribe en `real_readiness` los chequeos de la cuenta de Binance: al arrancar y cada
// 5 min. El dashboard nunca llama a Binance; lee esta fila para decir qué falta, así que
// se escribe también sin claves. Los últimos chequeos quedan a mano para el gating.

import type { Repos } from '@sereno/db'
import type { RealCheck } from '@sereno/shared'
import type { BotConfig } from '../config'
import { MINUTE_MS, type Scheduler } from '../live/scheduler'
import type { Clock } from '../live/timers'
import { inspectRealAccount, type ChecksSession, type ChecksTrade } from './checks'

export const READINESS_PERIOD_MS = 5 * MINUTE_MS

export interface ReadinessWriterDeps {
  repos: Pick<Repos, 'realReadiness'>
  // null sin claves de operación.
  trade: ChecksTrade | null
  config: Pick<BotConfig['real'], 'enabled' | 'env' | 'apiKey' | 'apiSecret'>
  instanceId: string
  clock: Pick<Clock, 'now'>
  // Se lee en cada corrida (la sesión real puede crearse o cambiar entre una y otra) y en
  // cada `latest`; null si no hay sesión real activa.
  session: () => ReadinessSession | null
}

export interface ReadinessSession extends ChecksSession {
  id: string
}

interface Revision {
  sessionId: string | null
  checks: readonly RealCheck[]
}

export class ReadinessWriter {
  private last: Revision | null = null
  private running: Promise<RealCheck[]> | null = null
  private queued: Promise<RealCheck[]> | null = null

  constructor(private readonly deps: ReadinessWriterDeps) {}

  // Los de la última corrida; vacío antes de la primera o si se hicieron para otra sesión
  // (o sin ninguna): el gating no abre con eso hasta la próxima.
  get latest(): readonly RealCheck[] {
    if (this.last === null || this.last.sessionId !== (this.deps.session()?.id ?? null)) return []
    return this.last.checks
  }

  // Nunca dos a la vez, así la fila y `latest` quedan con la última pedida: una pedida
  // durante otra corre cuando ésa termina, y las que llegan mientras espera se suman a ella.
  // Cada corrida lee la sesión recién cuando arranca.
  run(): Promise<RealCheck[]> {
    if (this.queued !== null) return this.queued
    if (this.running === null) return this.launch()
    const settle = (): void => undefined
    this.queued = this.running.then(settle, settle).then(() => {
      this.queued = null
      return this.launch()
    })
    return this.queued
  }

  private launch(): Promise<RealCheck[]> {
    const current = this.check().finally(() => {
      if (this.running === current) this.running = null
    })
    this.running = current
    return current
  }

  private async check(): Promise<RealCheck[]> {
    const { repos, trade, config, instanceId, clock } = this.deps
    const keysPresent = config.apiKey !== null && config.apiSecret !== null && trade !== null
    const session = this.deps.session()
    const report = await inspectRealAccount({
      trade,
      env: config.env,
      keysPresent,
      session,
      now: clock.now,
    })
    // Antes de escribir: si la base falla, el gating igual usa la revisión recién hecha.
    this.last = { sessionId: session?.id ?? null, checks: report.checks }
    await repos.realReadiness.upsert({
      env: config.env,
      enabled: config.enabled,
      keysPresent,
      checks: report.checks,
      walletAvailable: report.walletAvailable,
      instanceId,
    })
    return report.checks
  }

  // Programa las corridas y hace la primera ya. Se programa antes: si la primera falla (la
  // base caída al arrancar), el error sube y la próxima vuelve a intentar igual.
  start(scheduler: Pick<Scheduler, 'add'>): Promise<RealCheck[]> {
    scheduler.add({
      name: 'real_readiness',
      period: READINESS_PERIOD_MS,
      run: async () => {
        await this.run()
      },
    })
    return this.run()
  }
}
