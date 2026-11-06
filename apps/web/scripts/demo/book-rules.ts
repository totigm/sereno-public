import type { ClosedPosition } from '@sereno/core'
import type { Settings } from '@sereno/shared'
import { CYCLE_MS, HOUR_MS, utcDay } from './time'

// Las reglas de entrada que el escenario no puede violar (spec §5.4 y §7): si un
// trade inventado abriera en enfriamiento, en racha de stops o pasado el corte
// diario, la demostración mostraría algo que el bot nunca haría. Se lanza en vez
// de corregir: el escenario está mal escrito.
export class EntryRules {
  private readonly lastLoss = new Map<string, number>()
  private consecutiveStops = 0
  private lastStopAt = 0
  private readonly realizedByDay = new Map<string, number>()

  constructor(private readonly book: string) {}

  recordClose(closed: ClosedPosition): void {
    if (closed.pnlNet < 0) this.lastLoss.set(closed.symbol, closed.closedAt)
    if (closed.closeReason === 'stop') {
      this.consecutiveStops++
      this.lastStopAt = closed.closedAt
    } else {
      this.consecutiveStops = 0
    }
    const day = utcDay(closed.closedAt)
    this.realizedByDay.set(day, (this.realizedByDay.get(day) ?? 0) + closed.pnlNet)
  }

  assertCanOpen(id: string, symbol: string, at: number, capitalBase: number, settings: Settings): void {
    const fail = (why: string): never => {
      throw new Error(`Escenario incoherente (${this.book}): el trade ${id} abre en ${symbol} ${why}`)
    }
    const loss = this.lastLoss.get(symbol)
    if (loss !== undefined && at < loss + settings.entry.cooldownCandlesAfterLoss * CYCLE_MS) fail('en enfriamiento')
    if (this.consecutiveStops >= settings.risk.maxConsecutiveStops && at < this.lastStopAt + settings.risk.streakPauseHours * HOUR_MS) {
      fail('en la pausa por racha de stops')
    }
    const today = this.realizedByDay.get(utcDay(at)) ?? 0
    if (today <= -settings.risk.dailyLossLimit * capitalBase) fail('con la pérdida diaria alcanzada')
  }
}
