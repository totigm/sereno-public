import type { CloseReason, ClosedPosition, Composite, Position } from '../types'
import { coinName } from './coin-name'
import { formatLeverage, formatPnl, formatPrice, formatPriceRange, formatR, formatUsdRound } from './format'
import { pickReasons, reasonSentence } from './reasons'

// Frases del diario (spec §5.6, §7, §8, §11.1): el bot habla en primera persona
// ("Abrí", "Cerré", "Miré") y le habla a Toti de vos. Este módulo es la entrada
// única de las frases; las de espera, cuenta, titular y capital viven en archivos
// propios y se reexportan acá.
export { phraseWait } from './wait'
export { phraseLearning } from './learning-phrase'
export { phraseAccountRule, phraseShadowDrawdown, phraseShield, type AccountRule, type AccountRuleData, type ShieldPhraseInput } from './account-phrases'
export { headline, type HeadlineInput } from './headline'
export { capitalCard, type CapitalCard, type CapitalCardInput } from './capital-card'
export { REASON_PHRASES, SIGNAL_NAMES } from './reasons'

const MINUTE_MS = 60_000

// Cuánto estuvo abierta, para "Cerré … <a las 8 horas> sin despegar". `timeExitHours`
// admite cualquier valor positivo, así que hacen falta el singular y los minutos.
function afterElapsed(ms: number): string {
  const total = Math.floor(ms / MINUTE_MS)
  const hours = Math.floor(total / 60)
  const minutes = total % 60
  if (hours === 0) return minutes <= 1 ? 'al minuto' : `a los ${minutes} minutos`
  const inHours = hours === 1 ? 'a la hora' : `a las ${hours} horas`
  if (minutes === 0) return inHours
  if (minutes === 30) return `${inHours} y media`
  return `${inHours} y ${minutes} ${minutes === 1 ? 'minuto' : 'minutos'}`
}

export function phraseOpen(p: Position, c: Composite): string {
  const what = `Abrí un ${p.side} ${formatLeverage(p.leverage)} en ${coinName(p.symbol)} con ${formatUsdRound(p.margin)}.`
  return `${what} ${reasonSentence(pickReasons(c, p.side), p.side)}`
}

export function phraseLiquidation(p: ClosedPosition): string {
  return `Me liquidaron el ${p.side} en ${coinName(p.symbol)}: perdí los ${formatUsdRound(p.margin)} de margen.`
}

type RegularClose = Exclude<CloseReason, 'liquidation' | 'stop_missed_offline' | 'closed_on_exchange' | 'unprotected'>

// Cómo o por qué cerró, para "Cerré el long en SOL <así>: +US$ 12,40 (+2,0R)."
const CLOSE_HOW: Record<RegularClose, (p: ClosedPosition) => string> = {
  stop: () => 'en el stop',
  take_profit: () => 'en el take profit',
  trailing_stop: () => 'en el trailing stop',
  signal_flip: () => 'porque las señales se dieron vuelta',
  time_exit: (p) => `${afterElapsed(p.closedAt - p.openedAt)} sin despegar`,
  manual: () => 'porque me lo pediste',
  close_all: () => 'al cerrar todo',
  shield_reduce: () => 'para blindar el capital inicial',
  delisted: () => 'porque el contrato se deslista',
  session_archived: () => 'al archivar la simulación',
  loss_floor: () => 'por el tope de pérdida',
}

export function phraseClose(p: ClosedPosition): string {
  const which = `el ${p.side} en ${coinName(p.symbol)}`
  switch (p.closeReason) {
    case 'liquidation':
      return phraseLiquidation(p)
    case 'stop_missed_offline':
      return `Cerré ${which} al reconectar: el stop había quedado atrás mientras estaba sin conexión (${formatPnl(p.pnlNet)}).`
    case 'closed_on_exchange':
      return `La posición ${p.side} en ${coinName(p.symbol)} quedó cerrada en Binance: ${formatPnl(p.pnlNet)} (${formatR(p.rMultiple)}).`
    case 'unprotected':
      return `No pude poner el stop en Binance para la posición ${p.side} en ${coinName(p.symbol)}: la cerré para no dejarla sin protección (${formatPnl(p.pnlNet)}).`
    default:
      return `Cerré ${which} ${CLOSE_HOW[p.closeReason](p)}: ${formatPnl(p.pnlNet)} (${formatR(p.rMultiple)}).`
  }
}

// El trailing mueve el stop exactamente a la entrada al pasar +1R; la tolerancia
// relativa sólo absorbe el residuo de coma flotante.
function isEntry(price: number, entry: number): boolean {
  return Math.abs(price - entry) <= Math.abs(entry) * 1e-9
}

export function phraseLiquidationRecalculated(p: Position, from: number, to: number): string {
  const [fromText, toText] = formatPriceRange(from, to)
  return `Binance cambió el margen de mantenimiento de ${coinName(p.symbol)}: la liquidación del ${p.side} pasa de ${fromText} a ${toText}.`
}

export function phraseStopMoved(p: Position, from: number, to: number): string {
  const which = `el stop del ${p.side} en ${coinName(p.symbol)}`
  if (isEntry(to, p.entryPrice)) return `Moví ${which} a la entrada (${formatPrice(to)}).`
  const verb = to > from ? 'Subí' : 'Bajé'
  const [fromText, toText] = formatPriceRange(from, to)
  return `${verb} ${which} de ${fromText} a ${toText}.`
}
