import type { Decision } from '@sereno/core'
import type { decisions, DecisionActionLabel, ShadowActionLabel } from '../schema'

// La acción tal como la guarda la base (spec §10): la dirección de una entrada
// sale del plan; un bloqueo lleva el filtro en la etiqueta y en `blockedBy`.
export function actionLabel(action: Decision['action']): DecisionActionLabel {
  switch (action.kind) {
    case 'enter':
      return action.plan.side === 'long' ? 'enter_long' : 'enter_short'
    case 'wait':
      return 'wait'
    case 'blocked':
      return `blocked:${action.reason}`
  }
}

// La sombra sólo informa la clase de acción: si entró, la dirección es el signo de su S'.
export function shadowLabel(shadow: Decision['shadow']): ShadowActionLabel | null {
  if (!shadow) return null
  if (shadow.action !== 'enter') return shadow.action
  return shadow.Sprime >= 0 ? 'enter_long' : 'enter_short'
}

// `t` es el cierre de la vela que se evaluó.
export function decisionValues(sessionId: string, d: Decision) {
  return {
    sessionId,
    symbol: d.symbol,
    candleCloseTime: new Date(d.t),
    s: d.composite.S,
    sPrime: d.composite.Sprime,
    signals: d.composite.signals,
    missingSignals: d.composite.missing,
    action: actionLabel(d.action),
    blockedBy: d.action.kind === 'blocked' ? d.action.reason : null,
    shadowAction: shadowLabel(d.shadow),
  } satisfies typeof decisions.$inferInsert
}
