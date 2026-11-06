import type { Settings } from '@sereno/shared'
import { direction } from '../exchange/sides'
import type { BlockReason, EntryPlan, Position } from '../types'

// Tope de pérdida de la sesión: la equity nunca debería bajar de
// `capitalInicial × (1 − lossCap)`. Al abrir es una garantía por tamaño (esto); en
// marcha, el motor cierra todo si la equity toca el piso (`Desk.lossFloorPass`).

type CostRates = Pick<Settings['risk'], 'takerFeeRate' | 'slippageRate'>

// El piso, o null si la regla está apagada. En papel y replay sólo `lossCap < 1` la prende:
// así un `undefined` o `NaN` de ajustes viejos que llegan sin pasar por zod (los fixtures de
// replay) la deja apagada, igual que el 1 por defecto. Con plata real (`realMoney`) nunca se
// apaga: al 100% el piso es 0, no perder más que lo asignado (las comisiones y el funding
// pueden llevar la equity ahí sin pasar por un stop).
export function lossFloor(capitalInicial: number, lossCap: number | undefined, realMoney = false): number | null {
  const on = lossCap !== undefined && lossCap < 1
  if (!on && !realMoney) return null
  return capitalInicial * (1 - (on ? lossCap : 1))
}

export interface WorstCaseInput {
  saldo: number
  open: readonly Position[]
  plan?: EntryPlan
  risk: CostRates
}

// La equity si todas las abiertas (y el plan nuevo) salieran por su stop: el saldo ya
// descontó las comisiones de entrada de las abiertas; a cada una le queda lo que va de
// la entrada al stop (suma si el stop ya está en ganancia) y la salida, que es
// condicional y paga dos slippages, como en el simulador. El plan paga además su entrada
// a mercado. El funding no entra: no se puede acotar de antemano.
export function worstCaseEquity({ saldo, open, plan, risk }: WorstCaseInput): number {
  const exit = (notional: number) => notional * (risk.takerFeeRate + 2 * risk.slippageRate)
  const entry = (notional: number) => notional * (risk.takerFeeRate + risk.slippageRate)
  const atStops = open.reduce((acc, p) => acc + direction(p.side) * (p.stopPrice - p.entryPrice) * p.qty - exit(p.qty * p.stopPrice), 0)
  const planned = plan ? -plan.riesgoReal - entry(plan.notional) - exit(plan.qty * plan.stopPrice) : 0
  return saldo + atStops + planned
}

export interface LossFloorCheck {
  capitalInicial: number
  saldo: number
  open: readonly Position[]
  plan: EntryPlan
  settings: Pick<Settings, 'risk'>
  realMoney?: boolean
}

// `loss_floor` si abrir el plan puede dejar la equity, en el peor caso, bajo el piso.
export function checkLossFloor({ capitalInicial, saldo, open, plan, settings, realMoney = false }: LossFloorCheck): Extract<BlockReason, 'loss_floor'> | null {
  const floor = lossFloor(capitalInicial, settings.risk.lossCap, realMoney)
  if (floor === null) return null
  return worstCaseEquity({ saldo, open, plan, risk: settings.risk }) < floor ? 'loss_floor' : null
}
