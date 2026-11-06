import { SIGNAL_IDS, type Decision, type SignalId } from '../types'
import { CANDLE_MS, utcDay } from './clock'
import type { DataGap, MissingMarkWindow, MissingSignalWindow } from './types'

// Qué datos tuvo el replay: las monedas evaluadas cada día, los tramos en que faltó cada
// señal (spec §9: "la lista de señales no disponibles con sus fechas") y los tramos sin
// vela de marca. Se arma decisión por decisión, así el replay no necesita guardarlas.

export class Coverage {
  private readonly byDay: Record<string, string[]>
  private readonly seen = new Set<string>()
  private readonly lastDecision = new Map<string, number>()
  private readonly signals = new GapWindows<MissingSignalWindow>()
  private readonly marks = new GapWindows<MissingMarkWindow>()

  // `markFallback(symbol, t)`: la vela de 15m que abre en `t` no tuvo vela de marca.
  constructor(
    days: readonly string[],
    private readonly markFallback: (symbol: string, t: number) => boolean,
  ) {
    this.byDay = Object.fromEntries(days.map((day) => [day, []]))
  }

  add({ t, symbol, composite }: Decision): void {
    this.noteDay(t, symbol)
    // Un tramo sigue mientras la moneda decide en velas consecutivas; se corta cuando el
    // dato vuelve o cuando la moneda deja de decidir (salió del universo).
    const consecutive = this.lastDecision.get(symbol) === t - CANDLE_MS
    this.lastDecision.set(symbol, t)
    const missing = new Set<SignalId>(composite.missing)
    for (const signal of SIGNAL_IDS) {
      this.signals.note(`${signal}|${symbol}`, missing.has(signal), consecutive, t, () => ({ signal, symbol, from: t, to: t, decisions: 1 }))
    }
    this.marks.note(symbol, this.markFallback(symbol, t), consecutive, t, () => ({ symbol, from: t, to: t, decisions: 1 }))
  }

  // Las monedas con decisión en cada día, en el orden en que aparecieron. Los días sin
  // ninguna (universo vacío) quedan con la lista vacía.
  universeByDay(): Record<string, string[]> {
    return this.byDay
  }

  missingSignalWindows(): MissingSignalWindow[] {
    return this.signals.all().sort((a, b) => SIGNAL_IDS.indexOf(a.signal) - SIGNAL_IDS.indexOf(b.signal) || bySymbolThenFrom(a, b))
  }

  missingMarkWindows(): MissingMarkWindow[] {
    return this.marks.all().sort(bySymbolThenFrom)
  }

  private noteDay(t: number, symbol: string): void {
    const day = utcDay(t)
    const key = `${day}|${symbol}`
    if (this.seen.has(key)) return
    this.seen.add(key)
    ;(this.byDay[day] ??= []).push(symbol)
  }
}

// Tramos, abiertos y cerrados, de algo que falta en decisiones consecutivas de una moneda.
class GapWindows<W extends DataGap> {
  private readonly open = new Map<string, W>()
  private readonly closed: W[] = []

  note(key: string, missing: boolean, consecutive: boolean, t: number, start: () => W): void {
    const window = this.open.get(key)
    if (window && missing && consecutive) {
      window.to = t
      window.decisions += 1
      return
    }
    if (window) {
      this.closed.push(window)
      this.open.delete(key)
    }
    if (missing) this.open.set(key, start())
  }

  all(): W[] {
    return [...this.closed, ...this.open.values()]
  }
}

function bySymbolThenFrom(a: DataGap, b: DataGap): number {
  return (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0) || a.from - b.from
}
