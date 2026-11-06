import type { BlockReason } from '@sereno/core'
import { formatLeverage } from '@sereno/core/src/journal/format'
import { phraseWait } from '@sereno/core/src/journal/phrases'
import type { SymbolStats } from '@sereno/core/src/stats/stats'
import type { UniverseExclusionReason } from '@sereno/core/src/universe/select-universe'
import { coinName } from '@sereno/core/src/journal/coin-name'
import type { UniverseExcludedEntry } from '@sereno/db'
import { sinceClock } from '@/components/status/clock-labels'
import { BA_TZ, formatDateBA, formatNumber, formatPct, formatSigned, formatUsd, relativeAge } from '@/lib/format'
import type { CoinDecisionView, CoinInfo } from '@/lib/queries/monedas'
import type { TileModel, TileState } from './tile-model'

// Textos de la pantalla Monedas: el bot habla en primera persona ("Miré", "Me inclino")
// como en el diario, y en pasado cuando se mira un replay o una simulación archivada.

/** Desde dónde se mira el tablero: el titular y los estados cambian de tiempo verbal. */
export type BoardMode = 'live' | 'offline' | 'replay' | 'archived'

const MINUTE_MS = 60_000
/** Por debajo de esto el S′ se lee como 0,00: no hay inclinación que contar. */
const NEUTRAL = 0.005

const shortDateFormat = new Intl.DateTimeFormat('es-AR', { timeZone: BA_TZ, day: 'numeric', month: 'numeric' })

/** `"7/11"`: el día de vuelta de una penitencia, corto para que entre en la baldosa. */
function shortDate(at: number): string {
  return shortDateFormat.format(at)
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

const capitalize = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`

/** Lo que falta, redondeado para arriba: `"45 min"`, `"1 h"`, `"1 h 15 min"`. */
function remaining(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / MINUTE_MS))
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}

export function boardHeadline(count: number, open: number, mode: BoardMode): string {
  const coins = plural(count, 'moneda', 'monedas')
  const held = open === 0 ? 'sin posiciones abiertas' : `con ${plural(open, 'posición abierta', 'posiciones abiertas')}`
  switch (mode) {
    case 'live':
      return `Mirando ${coins}, ${held}.`
    case 'offline':
      return `Miraba ${coins}, ${held}.`
    case 'replay':
      return `Al terminar el replay miraba ${coins}, ${held}.`
    case 'archived':
      return `Al archivar la simulación miraba ${coins}, ${held}.`
  }
}

/** La línea de estado de la baldosa (spec §11.1); null si está lista o tiene posición. */
export function tileStateText(state: TileState, ref: number, past: boolean): string | null {
  switch (state.kind) {
    case 'degraded':
      if (state.since === null) return 'sin datos'
      if (past) return `sin datos desde ${sinceClock(state.since, ref)}`
      return ref - state.since < MINUTE_MS ? 'sin datos' : `sin datos ${relativeAge(state.since, ref)}`
    case 'cooldown':
      if (state.until === null) return 'en enfriamiento'
      return `${past ? 'esperaba' : 'espera'} ${remaining(state.until - ref)}`
    case 'penalized':
      if (state.until === null) return 'en penitencia'
      return `${past ? 'volvía' : 'vuelve'} el ${shortDate(state.until)}`
    case 'position':
    case 'ready':
      return null
  }
}

const sideLabel = (side: 'long' | 'short'): string => (side === 'long' ? 'Long' : 'Short')

/** El chip de la baldosa con posición: `"L 5x"`, `"S 3x"`. */
export function positionChip(side: 'long' | 'short', leverage: number): string {
  return `${side === 'long' ? 'L' : 'S'} ${formatLeverage(leverage)}`
}

function leanLabel(sPrime: number | null): string {
  if (sPrime === null) return 'sin puntaje'
  if (Math.abs(sPrime) < NEUTRAL) return 'sin inclinación'
  return `se inclina a ${sPrime > 0 ? 'long' : 'short'} (${formatSigned(sPrime, 2)})`
}

/**
 * Nombre accesible de la baldosa: todo lo que se ve en ella, más lo que el color
 * dice solo (el resultado de la abierta, hacia dónde se inclina).
 */
export function tileLabel(tile: TileModel, ref: number, past: boolean): string {
  const { state } = tile
  const value =
    state.kind === 'position'
      ? `${sideLabel(state.side)} ${formatLeverage(state.leverage)}${state.net === null ? '' : ` con ${formatUsd(state.net, { sign: true })}`}`
      : tile.change24h === null
        ? 'sin cambio de 24 h'
        : `${formatPct(tile.change24h)} en 24 h`
  const status = tileStateText(state, ref, past)
  return [tile.name, value, leanLabel(tile.sPrime), ...(status === null ? [] : [status])].join(', ')
}

export function leanSentence(sPrime: number | null, theta: number, past: boolean): string {
  if (sPrime === null) return 'Sin puntaje en el último ciclo.'
  if (Math.abs(sPrime) < NEUTRAL) return past ? 'No me inclinaba para ningún lado.' : 'No me inclino para ningún lado.'
  const side = sPrime > 0 ? 'long' : 'short'
  const passes = Math.abs(sPrime) >= theta
  const verdict = past ? (passes ? 'pasaba el' : 'no llegaba al') : passes ? 'pasa el' : 'no llega al'
  return `${past ? 'Me inclinaba' : 'Me inclino'} a ${side} con ${formatSigned(sPrime, 2)}: ${verdict} umbral de ${formatNumber(theta, 2)}.`
}

const BLOCKED_PREFIX = 'blocked:'

/** La última decisión sobre la moneda, como la contaría el diario. */
export function decisionSentence(symbol: string, decision: CoinDecisionView, past: boolean): string {
  const name = coinName(symbol)
  const { action } = decision
  if (action === 'enter_long' || action === 'enter_short') return `Abrí un ${action === 'enter_long' ? 'long' : 'short'} en ${name}.`
  if (action === 'wait') return `Miré ${name} y esperé: la inclinación ${past ? 'no llegaba' : 'no llega'} al umbral.`
  const reason = decision.blockedBy ?? (action.slice(BLOCKED_PREFIX.length) as BlockReason)
  return phraseWait(symbol, reason, decision)
}

export function confidenceSentence(info: CoinInfo, past: boolean): string {
  if (info.learnedTrades === 0) {
    return `${past ? 'No cerré' : 'Todavía no cerré'} trades en ${info.name}: confianza neutra y tamaño completo.`
  }
  const size = info.multiplier >= 0.995 ? 'el tamaño completo' : `el ${formatPct(info.multiplier, 0, false)} del tamaño`
  const trades = plural(info.learnedTrades, 'trade cerrado', 'trades cerrados')
  return `Con ${trades}, confianza ${formatSigned(info.confidence, 2)}: ${past ? 'abría' : 'abro'} con ${size}.`
}

export function penaltySentence(name: string, until: number, past: boolean): string {
  const date = formatDateBA(until)
  return past ? `Estaba en penitencia hasta el ${date}.` : `En penitencia hasta el ${date}: no abro en ${name} hasta entonces.`
}

export function statsSentence(stats: SymbolStats | null, name: string, past: boolean): string {
  if (stats === null || stats.trades === 0) return past ? `No operé ${name}.` : `Todavía no operé ${name}.`
  const times = stats.trades === 1 ? 'una vez' : `${stats.trades} veces`
  const won = stats.wins === 0 ? 'ninguna ganada' : plural(stats.wins, 'ganada', 'ganadas')
  return `Operé ${name} ${times}: ${won}, ${formatUsd(stats.pnlNet, { sign: true })} en total.`
}

/** El estado de la moneda dicho en la hoja, con el porqué; null si está lista o con posición. */
export function stateSentence(state: TileState, name: string, ref: number, past: boolean): string | null {
  switch (state.kind) {
    case 'degraded': {
      const text = capitalize(tileStateText(state, ref, past) ?? 'sin datos')
      return past ? `${text}.` : `${text}: no evalúo entradas en ${name} hasta que vuelvan.`
    }
    case 'cooldown':
      if (state.until === null) return `Después de una pérdida ${past ? 'dejaba' : 'dejo'} pasar unas velas antes de volver a entrar.`
      return past
        ? `Después de una pérdida dejaba pasar unas velas: podía volver a entrar en ${remaining(state.until - ref)}.`
        : `Después de una pérdida dejo pasar unas velas: puedo volver a entrar en ${remaining(state.until - ref)}.`
    case 'penalized':
      if (state.until === null) return `${past ? 'Estaba' : 'Está'} en penitencia por cómo le fue últimamente.`
      return penaltySentence(name, state.until, past)
    case 'position':
    case 'ready':
      return null
  }
}

/** Un día `YYYY-MM-DD` (UTC) como "15 de octubre": al mediodía UTC cae el mismo día en Buenos Aires. */
function utcDayLabel(day: string): string {
  const at = Date.parse(`${day}T12:00:00Z`)
  return Number.isFinite(at) ? formatDateBA(at) : day
}

const EXCLUSION: Record<UniverseExclusionReason, (detail: string | undefined, minHistoryDays: number) => string> = {
  contract_type: () => 'no es un contrato perpetuo',
  status: () => 'Binance no la está operando',
  quote_asset: () => 'no cotiza en USDT',
  underlying_type: () => 'no es una cripto',
  tradfi: () => 'es TradFi y está apagado en Ajustes',
  stablecoin: () => 'es una stablecoin',
  history: (detail, days) => `${detail === undefined ? '' : `se listó el ${utcDayLabel(detail)} y `}necesita ${days} días de historia`,
  excluded: () => 'la excluiste',
  no_volume: () => 'no tuvo volumen en las últimas 24 h',
  no_contract: () => 'no existe en Binance',
}

/** Por qué una moneda quedó afuera del universo del día (spec §5.1). */
export function exclusionText(entry: UniverseExcludedEntry, minHistoryDays: number): string {
  const reason = EXCLUSION[entry.reason](entry.detail, minHistoryDays)
  return entry.pinned ? `Fijada, pero ${reason}.` : `${capitalize(reason)}.`
}
