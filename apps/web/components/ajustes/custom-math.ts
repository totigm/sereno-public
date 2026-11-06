import type { Side } from '@sereno/core'
import { formatLeverage, formatUsdRound } from '@sereno/core/src/journal/format'
import { liquidationFarEnough, liquidationPrice } from '@sereno/core/src/risk/liquidation'
import type { Settings } from '@sereno/shared'
import { formatPctTrim, formatUsdSigned } from './units'

// Cuentas del modo "Yo fijo tamaño y salidas" (spec §5.5): la traducción en vivo de TP y
// SL y la validación contra la liquidación. La liquidación sale de la misma fórmula que
// usa el bot (`liquidationPrice` de core), con el mmr de la tabla de ajustes de las monedas
// que puede operar.

type Custom = Settings['custom']
type MmrTable = Pick<Settings['risk'], 'mmrBySymbol' | 'mmrDefault'>

/** Margen de cada operación: fijo en dólares o una parte del capital base. */
export function customMargin(margin: Custom['marginPerTrade'], capitalBase: number): number {
  return margin.kind === 'usd' ? margin.value : margin.value * capitalBase
}

/**
 * "SL 2% del precio = −US$ 5 de los US$ 50 (−10%)": el movimiento por el apalancamiento,
 * sobre el margen. Con margen aislado no se pierde más que el margen: si el SL queda en la
 * liquidación o más allá (`liquidation`, distancia como fracción del precio), lo que pasa
 * antes es la liquidación.
 */
export function exitTranslation(kind: 'tp' | 'sl', pricePct: number, margin: number, leverage: number, liquidation?: number): string {
  const sign = kind === 'tp' ? 1 : -1
  const ofMargin = formatPctTrim(sign * pricePct * leverage, true)
  const head = `${kind.toUpperCase()} ${formatPctTrim(pricePct)} del precio`
  if (kind === 'sl' && liquidation !== undefined && pricePct >= liquidation) {
    const lost = margin > 0 ? `los ${formatUsdRound(margin)} del margen` : 'el margen'
    return `${head}: antes te liquidan, a ${formatPctTrim(Number(liquidation.toFixed(3)))} del precio, y perdés ${lost}`
  }
  if (!(margin > 0)) return `${head} = ${ofMargin} del margen`
  return `${head} = ${formatUsdSigned(sign * margin * leverage * pricePct)} de los ${formatUsdRound(margin)} (${ofMargin})`
}

interface TradableSource {
  market: { symbols: readonly { symbol: string }[] } | null
  open: readonly { symbol: string }[]
}

/** Las monedas que el bot puede operar ahora: las del universo del tablero y las abiertas. */
export function tradableSymbols({ market, open }: TradableSource): string[] {
  return [...new Set([...(market?.symbols ?? []).map((s) => s.symbol), ...open.map((p) => p.symbol)])]
}

/**
 * El mmr que pone la liquidación más cerca entre las monedas que el bot puede operar. Con
 * la clave de Binance la tabla trae todas las perpetuas, y el bot valida cada entrada con
 * el mmr de su moneda: una ilíquida que nunca opera no tiene por qué bloquear el modo. El
 * de por defecto entra siempre: una moneda que entra mañana al universo sin fila lo usa.
 */
export function worstMmr(risk: MmrTable, symbols: readonly string[]): number {
  return Math.max(risk.mmrDefault, ...symbols.map((symbol) => risk.mmrBySymbol[symbol] ?? risk.mmrDefault))
}

const SIDES: Record<Custom['direction'], Side[]> = { both: ['long', 'short'], long: ['long'], short: ['short'] }

// Con la entrada en 1, la liquidación queda en "1 ± distancia".
const distanceFor = (side: Side, leverage: number, mmr: number): number => {
  const liq = liquidationPrice(side, 1, leverage, mmr)
  return side === 'long' ? 1 - liq : liq - 1
}

/** Distancia a la liquidación, como fracción del precio, del lado permitido que liquida más cerca. */
export function liquidationDistance(leverage: number, mmr: number, direction: Custom['direction']): number {
  return Math.min(...SIDES[direction].map((side) => distanceFor(side, leverage, mmr)))
}

/**
 * La regla de liquidación para cualquier guardado que cambie el modo, el mmr o los campos
 * del modo propio: en "Yo fijo tamaño y salidas" el SL tiene que quedar antes de la
 * liquidación; en el automático el tamaño ya la respeta.
 */
export function liquidationRule(next: Settings, symbols: readonly string[] = []): string | null {
  return next.mode === 'custom' ? liquidationWarning(next.custom, next.risk, symbols) : null
}

/**
 * Null si el SL queda antes de la liquidación en todos los lados permitidos (la misma
 * regla con que el bot rechaza la entrada); si no, el aviso para el campo.
 */
export function liquidationWarning(
  custom: Pick<Custom, 'leverage' | 'slPct' | 'direction'>,
  risk: MmrTable,
  symbols: readonly string[],
): string | null {
  const { leverage, slPct, direction } = custom
  const mmr = worstMmr(risk, symbols)
  const safe = SIDES[direction].every((side) =>
    liquidationFarEnough(
      { side, entry: 1, stopPrice: side === 'long' ? 1 - slPct : 1 + slPct, liquidationPrice: liquidationPrice(side, 1, leverage, mmr) },
      1,
    ),
  )
  if (safe) return null
  const distance = formatPctTrim(Number(liquidationDistance(leverage, mmr, direction).toFixed(3)))
  return `Con ${formatLeverage(leverage)} te liquidan a ${distance} del precio (mmr de ${formatPctTrim(mmr)}), antes del SL: bajá el SL o el apalancamiento.`
}
