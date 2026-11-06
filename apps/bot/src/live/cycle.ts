// Cierre de vela (spec §12): en el borde de 15m se espera, como mucho `decisionDeadlineMs`,
// a que lleguen las velas que cierran ahí (15m siempre; 1h y 4h cuando el borde coincide)
// de todos los símbolos, y a que termine un relleno por REST en curso. Las monedas cuya
// vela de 15m no llegó a tiempo van al motor como faltantes (`no_candle`).

import type { ViewTimeframe } from '@sereno/core/src/market/market-view'
import { INTERVAL_MS } from '../binance/types'
import type { MarketData } from './market-data'
import type { Clock } from './timers'

const TIMEFRAMES: readonly ViewTimeframe[] = ['15m', '1h', '4h']

interface Waiting {
  check: () => boolean
}

export class CandleGate {
  private readonly waiting = new Set<Waiting>()
  // Rellenos por REST en curso por símbolo.
  private readonly backfills = new Map<string, number>()

  constructor(
    private readonly market: MarketData,
    private readonly clock: Clock,
  ) {}

  beginBackfill(symbol: string): void {
    this.backfills.set(symbol, (this.backfills.get(symbol) ?? 0) + 1)
  }

  endBackfill(symbol: string): void {
    const left = (this.backfills.get(symbol) ?? 1) - 1
    if (left > 0) this.backfills.set(symbol, left)
    else this.backfills.delete(symbol)
    this.notify()
  }

  // Resuelve con los símbolos sin su vela de 15m de `t` al vencer el plazo (o [] antes, si llegaron todas).
  wait(t: number, symbols: readonly string[], deadlineMs: number): Promise<string[]> {
    const closing = TIMEFRAMES.filter((tf) => t % INTERVAL_MS[tf] === 0)
    const complete = (s: string) => !this.backfills.has(s) && closing.every((tf) => this.market.hasClose(s, tf, t, INTERVAL_MS[tf]))
    const missing = () => symbols.filter((s) => !this.market.hasClose(s, '15m', t, INTERVAL_MS['15m']))
    return new Promise((resolve) => {
      const entry: Waiting = {
        check: () => {
          if (!symbols.every(complete)) return false
          finish()
          return true
        },
      }
      const timer = this.clock.timers.setTimeout(() => finish(), Math.max(0, t + deadlineMs - this.clock.now()))
      const finish = () => {
        this.clock.timers.clearTimeout(timer)
        this.waiting.delete(entry)
        resolve(missing())
      }
      if (!entry.check()) this.waiting.add(entry)
    })
  }

  // Llegó una vela o terminó un relleno: se revisan las esperas.
  notify(): void {
    for (const entry of [...this.waiting]) entry.check()
  }
}
