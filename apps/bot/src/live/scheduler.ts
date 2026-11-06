// Programador del proceso en vivo (spec §12): cada trabajo corre en los múltiplos de su
// período (instantes UTC alineados, corridos por `offset`), así un cierre de vela de 15m
// cae justo en el borde y el universo a las 00:05 UTC. Una corrida que todavía no
// terminó no se superpone con la siguiente: esa se saltea.

import type { Clock, TimerHandle } from './timers'

export const SECOND_MS = 1_000
export const MINUTE_MS = 60 * SECOND_MS
export const HOUR_MS = 60 * MINUTE_MS
export const DAY_MS = 24 * HOUR_MS
// El 1/1/1970 fue jueves: tres días después cae domingo.
export const WEEK_SUNDAY_0030_OFFSET_MS = 3 * DAY_MS + 30 * MINUTE_MS

export interface Job {
  name: string
  period: number
  offset?: number
  // `at` es el instante programado de la corrida.
  run: (at: number) => Promise<void>
}

export interface SchedulerDeps {
  clock: Clock
  onError: (job: string, error: unknown) => void
}

// El primer instante alineado estrictamente posterior a `now`.
export function nextRun(now: number, period: number, offset = 0): number {
  return Math.floor((now - offset) / period) * period + offset + period
}

export class Scheduler {
  private readonly handles = new Map<string, TimerHandle>()
  private readonly running = new Set<string>()
  private stopped = false

  constructor(private readonly deps: SchedulerDeps) {}

  add(job: Job): void {
    if (this.handles.has(job.name)) throw new Error(`Scheduler: el trabajo ${job.name} ya está programado`)
    this.arm(job, this.deps.clock.now())
  }

  stop(): void {
    this.stopped = true
    for (const handle of this.handles.values()) this.deps.clock.timers.clearTimeout(handle)
    this.handles.clear()
  }

  private arm(job: Job, from: number): void {
    if (this.stopped) return
    const { clock } = this.deps
    const at = nextRun(from, job.period, job.offset ?? 0)
    this.handles.set(
      job.name,
      clock.timers.setTimeout(() => this.fire(job, at), at - clock.now()),
    )
  }

  private fire(job: Job, at: number): void {
    if (this.stopped) return
    // Un temporizador puede disparar un instante antes: el próximo se cuenta desde `at`.
    this.arm(job, Math.max(at, this.deps.clock.now()))
    if (this.running.has(job.name)) return
    this.running.add(job.name)
    job
      .run(at)
      .catch((error: unknown) => this.deps.onError(job.name, error))
      .finally(() => this.running.delete(job.name))
  }
}
