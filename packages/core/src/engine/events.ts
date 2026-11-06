import {
  phraseAccountRule,
  phraseClose,
  phraseLearning,
  phraseShadowDrawdown,
  phraseStopMoved,
  phraseWait,
  type AccountRule,
  type AccountRuleData,
} from '../journal/phrases'
import type { LearningChange } from '../learning/state'
import type { BlockReason, ClosedPosition, Composite, Decision, EngineEvent, Fill, Position, Side } from '../types'

// Los eventos que emite el motor, cada uno con su frase del diario (journal/phrases).

type EventOf<K extends EngineEvent['type']> = Extract<EngineEvent, { type: K }>

// La frase de apertura ya quedó en la posición (`openReason`) al abrirla.
export function positionOpened(position: Position, fill: Fill): EventOf<'position_opened'> {
  return { type: 'position_opened', position, fill, phrase: position.openReason }
}

export function positionClosed(position: ClosedPosition, fill: Fill): EventOf<'position_closed'> {
  return { type: 'position_closed', position, fill, phrase: phraseClose(position) }
}

export function stopMoved(position: Position, from: number, to: number, at: number): EventOf<'stop_moved'> {
  return { type: 'stop_moved', positionId: position.id, from, to, at, phrase: phraseStopMoved(position, from, to) }
}

export function fundingApplied(positionId: string, amount: number, at: number): EventOf<'funding_applied'> {
  return { type: 'funding_applied', positionId, amount, at }
}

// `message` es el registro técnico que va a `learning_log` (ids y símbolos de contrato);
// `phrase` es como lo lee Toti en el diario.
export function learningUpdated(change: LearningChange): EventOf<'learning_updated'> {
  return {
    type: 'learning_updated',
    at: change.at,
    message: change.message,
    sampleSize: change.sampleSize,
    before: change.before,
    after: change.after,
    kind: change.kind,
    symbol: change.symbol,
    signal: change.signal,
    phrase: phraseLearning(change),
  }
}

export function accountRuleTriggered<R extends AccountRule>(at: number, rule: R, data: AccountRuleData[R]): EventOf<'account_rule'> {
  return { type: 'account_rule', at, rule, phrase: phraseAccountRule(rule, data), data }
}

// El drawdown máximo de la sombra: no la pausa (no tiene quién la reanude), pero queda
// registrado, marcado como de la sombra para que no pause la sesión ni llegue al diario.
export function shadowDrawdown(at: number, data: AccountRuleData['drawdown']): EventOf<'account_rule'> {
  return { type: 'account_rule', at, rule: 'drawdown', shadow: true, phrase: phraseShadowDrawdown(data), data }
}

export function waited(t: number, symbol: string, reason: BlockReason, composite: Composite, wantedSide: Side | null): EventOf<'waited'> {
  return { type: 'waited', t, symbol, reason, phrase: phraseWait(symbol, reason, composite, wantedSide) }
}

export function decisionsMade(t: number, decisions: Decision[]): EventOf<'decisions'> {
  return { type: 'decisions', t, decisions }
}
