import type { Clock, TimerHandle, Timers } from '../../src/live/timers'

interface Pending {
  id: number
  at: number
  fn: () => void
}

// Reloj manual: el tiempo sólo avanza con `advance`, que dispara en orden los
// temporizadores vencidos y entre uno y otro deja correr lo asincrónico pendiente.
export class ManualClock implements Clock {
  private t: number
  private seq = 0
  private pending: Pending[] = []
  readonly timers: Timers

  constructor(start: number) {
    this.t = start
    this.timers = {
      setTimeout: (fn, ms): TimerHandle => {
        const timer = { id: ++this.seq, at: this.t + Math.max(0, ms), fn }
        this.pending.push(timer)
        return timer.id
      },
      clearTimeout: (handle) => {
        this.pending = this.pending.filter((p) => p.id !== handle)
      },
    }
  }

  readonly now = (): number => this.t

  get timerCount(): number {
    return this.pending.length
  }

  async advance(ms: number): Promise<void> {
    const target = this.t + ms
    for (;;) {
      await settle()
      const next = this.pending.filter((p) => p.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0]
      if (!next) break
      this.pending = this.pending.filter((p) => p !== next)
      this.t = Math.max(this.t, next.at)
      next.fn()
    }
    this.t = target
    await settle()
  }

  async advanceTo(t: number): Promise<void> {
    await this.advance(Math.max(0, t - this.t))
  }
}

// Unas vueltas del event loop: alcanza para que corran las continuaciones sin IO.
export async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve))
}
