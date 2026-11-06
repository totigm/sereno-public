// Reconstrucción del estado del motor al retomar una sesión (spec §12: idempotente ante
// reinicios). La base no guarda el estado del motor tal cual: se deriva de lo que sí
// guarda. Las abiertas salen de `positions` (los costos de entrada, de su evento `open`);
// el saldo, de I₀ más lo realizado; el blindaje real, de `sessions`; los cortes de cuenta
// (racha, enfriamientos, pérdida del día) se recalculan pasando los trades cerrados por
// el mismo `AccountGuard`; la pausa por drawdown, del último latido; el pico de equity,
// repitiendo la regla del drawdown sobre la curva (`drawdown-peak.ts`). La sombra
// re-aprende su penitencia con sus trades y vuelve a medir su pico desde el reinicio.

import type { ClosedPosition, LearningState, Position } from '@sereno/core'
import { AccountGuard, initialGuardState, type DrawdownBehavior, type GuardState } from '@sereno/core/src/engine/account-guard'
import type { EngineState, OpenPositionState } from '@sereno/core/src/engine/types'
import { updateConfidence } from '@sereno/core/src/learning/confidence'
import { initialLearningState } from '@sereno/core/src/learning/state'
import type { BotFlags } from '@sereno/db'
import { DEFAULT_SETTINGS, type Settings } from '@sereno/shared'

export interface AccountState {
  saldo: number
  protegido: number
  baseBlindaje: number
}

export interface RestoreInput {
  session: { capitalInicial: number; protegido: number; baseBlindaje: number; startedAt: number }
  settings: Settings
  // Reales y sombra (`position.shadow`).
  open: readonly OpenPositionState[]
  closed: readonly ClosedPosition[]
  lastFlags: BotFlags | null
  // Pico de equity desde que se levantó la última pausa por drawdown (null sin curva en ese tramo).
  equityPeak: number | null
  // Lo que un cerrado realizó antes de su cierre, por id: la comisión de entrada (en su
  // apertura) y cada funding (en su liquidación), con signo de resultado (un costo es
  // negativo). Hace falta sólo para los que abrieron otro día que el del cierre; sin dato,
  // el neto entero cuenta en el cierre.
  closedCosts?: ReadonlyMap<string, readonly RealizedAt[]>
}

export interface RealizedAt {
  at: number
  amount: number
}

export interface RestorePlan {
  state: EngineState
  real: AccountState
  shadow: AccountState
}

export function planRestore(input: RestoreInput): RestorePlan {
  const { session, settings, open, closed } = input
  const byClose = [...closed].sort((a, b) => a.closedAt - b.closedAt)
  const real = { open: open.filter((s) => !s.position.shadow), closed: byClose.filter((c) => !c.shadow) }
  const shadow = { open: open.filter((s) => s.position.shadow), closed: byClose.filter((c) => c.shadow) }

  const realAccount: AccountState = {
    saldo: balance(session.capitalInicial, real.closed, real.open),
    protegido: session.protegido,
    baseBlindaje: session.baseBlindaje,
  }
  const shadowAccount = shadowShield(session.capitalInicial, shadow.closed, shadow.open, settings.capital.protectPct)
  const capitalBase = (a: AccountState) => {
    const disponible = Math.max(0, a.saldo - a.protegido)
    return settings.capital.reinvest ? disponible : Math.min(disponible, a.baseBlindaje)
  }

  const realGuard: GuardState = {
    ...replayGuard(session.startedAt, real.closed, real.open, settings, capitalBase(realAccount), 'pause', input.closedCosts),
    drawdownPaused: input.lastFlags?.drawdownPause ?? false,
    equityPeak: input.equityPeak,
  }
  const shadowSettings = { ...settings, entry: DEFAULT_SETTINGS.entry }
  const shadowGuard: GuardState = {
    ...replayGuard(session.startedAt, shadow.closed, shadow.open, shadowSettings, capitalBase(shadowAccount), 'rebase', input.closedCosts),
    equityPeak: null,
  }

  return {
    state: {
      real: { positions: real.open.map(copy), guard: realGuard },
      shadow: { positions: shadow.open.map(copy), guard: shadowGuard, learning: shadowLearning(session.startedAt, shadow.closed) },
      waitedAt: {},
    },
    real: realAccount,
    shadow: shadowAccount,
  }
}

function copy(state: OpenPositionState): OpenPositionState {
  return structuredClone(state)
}

// I₀ + lo realizado: el neto de cada cerrado y lo ya pagado por las abiertas (la comisión
// de entrada y el funding se realizan al pasar, no al cerrar).
function balance(capitalInicial: number, closed: readonly ClosedPosition[], open: readonly OpenPositionState[]): number {
  const realized = closed.reduce((sum, c) => sum + c.pnlNet, 0)
  const paid = open.reduce((sum, s) => sum + s.position.feesPaid + s.position.fundingPaid, 0)
  return capitalInicial + realized - paid
}

// La sombra no persiste su blindaje: se repite con lo realizado de sus cierres (nunca
// lo libera nadie, así que una vez blindada queda así).
function shadowShield(capitalInicial: number, closed: readonly ClosedPosition[], open: readonly OpenPositionState[], protectPct: number): AccountState {
  let saldo = capitalInicial
  let protegido = 0
  for (const c of closed) {
    saldo += c.pnlNet
    if (protegido === 0 && protectPct > 0 && saldo - capitalInicial >= protectPct * capitalInicial) protegido = capitalInicial
  }
  return { saldo: saldo - open.reduce((sum, s) => sum + s.position.feesPaid + s.position.fundingPaid, 0), protegido, baseBlindaje: capitalInicial }
}

interface Realized {
  at: number
  amount: number
  closed?: ClosedPosition
}

// Los cortes de cuenta como los habría dejado el motor: cada resultado realizado en su
// instante, cada cierre por `noteClose` y una evaluación sin equity (el drawdown no se
// mide acá). La pérdida diaria usa el capital base de ahora. Como en vivo, la comisión de
// entrada y el funding de un cerrado cuentan cuando se pagaron (`closedCosts`) y en el
// cierre sólo lo que realizó el cierre: una posición de ayer cerrada hoy no le carga a
// hoy los costos de ayer.
function replayGuard(
  startedAt: number,
  closed: readonly ClosedPosition[],
  open: readonly OpenPositionState[],
  settings: Settings,
  capitalBase: number,
  drawdown: DrawdownBehavior,
  closedCosts: RestoreInput['closedCosts'],
): GuardState {
  const guard = new AccountGuard(initialGuardState(startedAt), { drawdown })
  const items: Realized[] = [
    ...closed.flatMap((c): Realized[] => {
      const before = closedCosts?.get(c.id) ?? []
      const paid = before.reduce((sum, r) => sum + r.amount, 0)
      return [...before.map((r) => ({ at: r.at, amount: r.amount })), { at: c.closedAt, amount: c.pnlNet - paid, closed: c }]
    }),
    ...open.map(({ position: p }: { position: Position }) => ({ at: p.openedAt, amount: -(p.feesPaid + p.fundingPaid) })),
  ].sort((a, b) => a.at - b.at)
  for (const item of items) {
    guard.noteRealized(item.amount, item.at)
    if (!item.closed) continue
    guard.noteClose(item.closed, settings.entry)
    guard.evaluate({ now: item.at, capitalBase, equity: null, settings })
  }
  return guard.snapshot()
}

function shadowLearning(startedAt: number, closed: readonly ClosedPosition[]): LearningState {
  return closed.reduce((state, c) => updateConfidence(state, c, DEFAULT_SETTINGS.learning, c.closedAt).state, initialLearningState(startedAt))
}
