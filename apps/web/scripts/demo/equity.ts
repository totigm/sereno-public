import type { AccountSnapshot, Position } from '@sereno/core'
import { Account } from '@sereno/core/src/capital/account'
import type { EquityPoint } from '@sereno/db'
import type { Settings } from '@sereno/shared'
import { cents, type BookResult } from './book'
import type { Market } from './market'
import { alignDown, HOUR_MS, MINUTE_MS } from './time'

// Estado de una cartera en un instante cualquiera, reconstruido desde su libro:
// saldo = I₀ + todo lo realizado hasta ahí (comisiones, cierres, funding), las
// abiertas valuadas al precio de ese momento y el blindaje si ya se disparó.
export function bookStateAt(book: BookResult, capitalInicial: number, settings: Settings, market: Market, at: number): AccountSnapshot {
  const saldo = book.ledger.reduce((sum, entry) => (entry.at <= at ? sum + entry.amount : sum), capitalInicial)
  const shielded = book.shield !== null && book.shield.at <= at
  const account = new Account({
    capitalInicial,
    reinvest: settings.capital.reinvest,
    protectPct: settings.capital.protectPct,
    onShield: settings.capital.onShield,
    saldo,
    protegido: shielded ? (book.shield?.protegido ?? 0) : 0,
    baseBlindaje: shielded ? (book.shield?.baseBlindaje ?? capitalInicial) : capitalInicial,
  })
  const open: Position[] = book.positions
    .filter((p) => p.position.openedAt <= at && (p.closed === null || p.closed.closedAt > at))
    .map((p) => p.position)
  const marks = Object.fromEntries(open.map((p) => [p.symbol, market.priceAt(p.symbol, at)]))
  return account.snapshot(open, marks)
}

// Puntos de la curva (spec §10): uno por minuto en el último tramo (`minuteTailMs`,
// las últimas 24 horas en vivo) y uno por hora antes, más uno por apertura y cierre.
export function sampleTimes(start: number, end: number, minuteTailMs: number): number[] {
  const out: number[] = []
  const recent = end - minuteTailMs
  for (let t = alignDown(start, HOUR_MS) + HOUR_MS; t < recent; t += HOUR_MS) out.push(t)
  for (let t = Math.max(alignDown(recent, MINUTE_MS) + MINUTE_MS, start); minuteTailMs > 0 && t <= end; t += MINUTE_MS) out.push(t)
  return out
}

export interface EquityInput {
  capitalInicial: number
  settingsAt: (t: number) => Settings
  market: Market
  real: BookResult
  shadow: BookResult
  start: number
  end: number
  minuteTailMs: number
}

export function equitySeries(input: EquityInput): EquityPoint[] {
  const { real, shadow, capitalInicial, market, settingsAt } = input
  const point = (at: number, kind: EquityPoint['kind']): EquityPoint => {
    const settings = settingsAt(at)
    const s = bookStateAt(real, capitalInicial, settings, market, at)
    const shadowState = bookStateAt(shadow, capitalInicial, settings, market, at)
    return {
      at,
      saldo: cents(s.saldo),
      equity: cents(s.equity),
      margenEnUso: cents(s.margenEnUso),
      protegido: cents(s.protegido),
      capitalBase: cents(s.capitalBase),
      capitalOperable: cents(s.capitalOperable),
      shadowEquity: cents(shadowState.equity),
      kind,
    }
  }
  const events = new Set<number>()
  for (const p of real.positions) {
    events.add(p.position.openedAt)
    if (p.closed) events.add(p.closed.closedAt)
  }
  if (real.shield) events.add(real.shield.at)
  return [
    ...sampleTimes(input.start, input.end, input.minuteTailMs).map((at) => point(at, 'minute')),
    ...[...events].filter((at) => at <= input.end).map((at) => point(at, 'event')),
  ].sort((a, b) => a.at - b.at || (a.kind === b.kind ? 0 : a.kind === 'event' ? 1 : -1))
}
