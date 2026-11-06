import type { BlockReason, Composite, Side } from '../types'
import { coinName } from './coin-name'

interface WaitContext {
  coin: string
  // El lado que quería abrir cuando se bloqueó la entrada.
  side: Side
}

const SIDE_PLURAL: Record<Side, string> = { long: 'longs', short: 'shorts' }

// Por qué no entró, dicho por el bot. Los filtros de entrada arrancan con "la
// inclinación es fuerte" porque el diario sólo muestra "esperé" cuando |S'| ya
// estaba cerca del umbral (spec §11.1).
const WAIT_PHRASES: Record<BlockReason, (ctx: WaitContext) => string> = {
  higher_trend_against: () => 'la inclinación es fuerte pero la tendencia en 1h y 4h va en contra',
  low_volume: () => 'la inclinación es fuerte pero el volumen no acompaña',
  has_position: ({ coin }) => `ya tengo una posición abierta en ${coin}`,
  cooldown: () => 'dejo pasar unas velas después de una pérdida',
  global_cooldown: () => 'saltaron varios stops en la última hora y dejo pasar unas velas antes de abrir',
  penalty: ({ coin }) => `${coin} está en penitencia por cómo le fue últimamente`,
  degraded: ({ coin }) => `me faltan datos de ${coin}`,
  max_positions: () => 'ya tengo el máximo de posiciones abiertas',
  max_same_direction: ({ side }) => `ya tengo el máximo de ${SIDE_PLURAL[side]} abiertos`,
  max_margin: () => 'ya tengo el máximo de margen en uso',
  max_notional: () => 'la exposición total ya está en el tope',
  insufficient_capital: () => 'no me alcanza el capital operable para el margen',
  daily_loss: () => 'ya llegué a la pérdida máxima del día',
  drawdown_pause: () => 'estoy pausado por el drawdown',
  streak_pause: () => 'estoy en pausa por una racha de stops',
  paused: () => 'estoy pausado',
  below_min_notional: () => 'el tamaño queda por debajo del mínimo del contrato',
  stop_too_small_for_cost: () => 'el stop queda demasiado chico para el costo',
  liquidation_too_close: () => 'la liquidación quedaba demasiado cerca del stop',
  risk_rounding: () => 'redondear la cantidad me obligaba a arriesgar de más',
  direction_not_allowed: ({ side }) => `me pediste que no abra ${SIDE_PLURAL[side]}`,
  no_candle: () => 'no tengo la vela de este ciclo',
  loss_floor: () => 'abrirla podía llevarme por debajo del tope de pérdida',
  opening_disabled: () => 'la operación con plata real está apagada: sólo cuido las abiertas',
  foreign_position: ({ coin }) => `tenés una posición tuya en ${coin}; no la toco`,
  exchange_rejected: () => 'Binance rechazó la orden',
}

// `wantedSide` es el de la decisión bloqueada (`DecisionAction.wantedSide`), que manda;
// sin él, el lado sale del signo de S'. Del compuesto sólo hace falta S': así la frase
// también se arma desde una decisión guardada (la hoja de la moneda del dashboard).
export function phraseWait(symbol: string, reason: BlockReason, c: Pick<Composite, 'Sprime'>, wantedSide: Side | null = null): string {
  const coin = coinName(symbol)
  const side: Side = wantedSide ?? (c.Sprime >= 0 ? 'long' : 'short')
  return `Miré ${coin} y esperé: ${WAIT_PHRASES[reason]({ coin, side })}.`
}
