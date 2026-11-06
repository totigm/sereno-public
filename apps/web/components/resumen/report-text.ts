import type { SignalId } from '@sereno/core'
import { coinName } from '@sereno/core/src/journal/coin-name'
import { formatUsdRound } from '@sereno/core/src/journal/format'
import { SIGNAL_NAMES } from '@sereno/core/src/journal/phrases'
import type { HistogramBin } from '@sereno/core/src/replay/types'
import { plural, shortDate, signalLabel } from '@/components/aprendizaje/labels'
import { formatNumber } from '@/lib/format'
import type { DayRange, MissingSignalView, ResumenReportView, UniverseChange, UniverseView } from '@/lib/queries/resumen-report'

// Los textos del reporte de un replay en Resumen (spec §9). Las fechas son los días UTC
// del replay (sus días, quincenas y universo se cuentan en UTC): en hora de Buenos Aires
// cada borde caería en el día anterior.

const DAY_MS = 86_400_000
const HALF_DAY_MS = DAY_MS / 2

/** En línea, hasta dos tramos por señal; con más, el resumen (y el detalle en la hoja). */
const INLINE_RANGES = 2

/** "2 ago": el día UTC de `at`. Al mediodía UTC, Buenos Aires está en la misma fecha. */
export function utcDayLabel(at: number, now: number): string {
  return shortDate(Math.floor(at / DAY_MS) * DAY_MS + HALF_DAY_MS, now)
}

/** "a", "a y b", "a, b y c". */
function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} y ${items.at(-1) ?? ''}`
}

/** "2 ago → 16 ago": la quincena es [from, to), así que termina el día antes de `to`. */
export function fortnightLabel({ from, to }: { from: number; to: number }, now: number): string {
  return `${utcDayLabel(from, now)} → ${utcDayLabel(to - 1, now)}`
}

function rangeText({ from, to }: DayRange, now: number): string {
  return from === to ? `el ${utcDayLabel(from, now)}` : `del ${utcDayLabel(from, now)} al ${utcDayLabel(to, now)}`
}

/** "del 2 ago al 30 sep, en 3 monedas"; con muchos tramos, "en 4 tramos entre el 2 ago y el 30 sep, …" salvo `full`. */
export function missingSignalText({ coins, ranges }: MissingSignalView, now: number, { full = false } = {}): string {
  const where = `en ${plural(coins, 'moneda', 'monedas')}`
  const first = ranges[0]
  const last = ranges.at(-1)
  if (!full && ranges.length > INLINE_RANGES && first && last) {
    return `en ${ranges.length} tramos entre el ${utcDayLabel(first.from, now)} y el ${utcDayLabel(last.to, now)}, ${where}`
  }
  return `${joinAnd(ranges.map((r) => rangeText(r, now)))}, ${where}`
}

/** Si alguna señal tiene más tramos de los que entran en línea: la hoja los muestra todos. */
export function hasHiddenRanges(missing: readonly MissingSignalView[]): boolean {
  return missing.some((m) => m.ranges.length > INLINE_RANGES)
}

const SURVIVORSHIP =
  'Las monedas salen de las que hoy cotizan en Binance: faltan las que dejaron de cotizar en el período, y eso puede hacer que el resultado se vea mejor de lo que hubiera sido (sesgo de supervivencia).'

/** Lo que hay que saber para leer el resultado: lo que el replay no pudo reproducir. El sesgo de supervivencia, siempre. */
export function reportCaveats(view: ResumenReportView | null, now: number): string[] {
  const lines = [SURVIVORSHIP]
  if (view === null) return lines
  const { futuresDataFrom, markFallbackCoins, drawdownPause, shadowOppositeSideCandles, failures, skipped } = view.caveats
  if (futuresDataFrom !== null) {
    lines.push(`Interés abierto y posicionamiento hay desde el ${utcDayLabel(futuresDataFrom, now)} (Binance guarda 30 días): antes, esas dos señales faltan.`)
  }
  if (markFallbackCoins > 0) {
    lines.push(`En ${plural(markFallbackCoins, 'moneda', 'monedas')} faltó a ratos el precio de marca: ahí stops, take profit y liquidaciones usaron el último precio.`)
  }
  if (drawdownPause !== null) {
    const { at, peak, equity } = drawdownPause
    lines.push(
      `El ${utcDayLabel(at, now)} se pausó por drawdown (de ${formatUsdRound(peak)} a ${formatUsdRound(equity)}): en un replay nadie reanuda, así que desde ahí no abrió más.`,
    )
  }
  if (shadowOppositeSideCandles > 0) {
    lines.push(
      `Durante ${plural(shadowOppositeSideCandles, 'vela', 'velas')} los originales iban del lado contrario: ahí sus salidas son optimistas y la comparación con lo aprendido los favorece.`,
    )
  }
  if (failures > 0) lines.push(`${plural(failures, 'operación del motor falló y se salteó', 'operaciones del motor fallaron y se saltearon')}.`)
  if (skipped.length > 0) {
    lines.push(`Binance rechazó los datos de ${joinAnd(skipped.map(coinName))}: ${skipped.length === 1 ? 'quedó' : 'quedaron'} fuera del universo.`)
  }
  return lines
}

const ARTICLE = /^(?:el|la|los|las) /

/** "Tendencia de 15 minutos y tendencia mayor": el par, con el segundo nombre como va dentro de una frase. */
export function pairLabel(a: SignalId, b: SignalId): string {
  return `${signalLabel(a)} y ${SIGNAL_NAMES[b].replace(ARTICLE, '')}`
}

/** "Entre 28 y 30 monedas por día, 34 distintas en los 90 días." */
export function universeSummary({ days, min, max, distinct }: UniverseView): string {
  if (min === max && distinct === max) return `Las mismas ${plural(max, 'moneda', 'monedas')} todos los días.`
  const perDay = min === max ? `${plural(max, 'moneda', 'monedas')} cada día` : `Entre ${formatNumber(min, 0)} y ${plural(max, 'moneda', 'monedas')} por día`
  return `${perDay}, ${formatNumber(distinct, 0)} distintas en los ${plural(days, 'día', 'días')}.`
}

/** "Entró PEPE. Salió SOL." */
export function universeChangeText({ added, removed }: UniverseChange): string {
  const part = (symbols: readonly string[], one: string, many: string) =>
    symbols.length === 0 ? null : `${symbols.length === 1 ? one : many} ${joinAnd(symbols.map(coinName))}.`
  return [part(added, 'Entró', 'Entraron'), part(removed, 'Salió', 'Salieron')].filter((p) => p !== null).join(' ')
}

/** S′ sin ceros de más en los enteros: "−1", "0", "0,35". */
function sprime(n: number): string {
  return formatNumber(n, 2).replace(/,00$/, '')
}

/** "De 0,35 a 0,40". */
export function binLabel({ from, to }: HistogramBin): string {
  return `De ${sprime(from)} a ${sprime(to)}`
}

// Las barras están alineadas con la grilla de θ (de a 0,05): se compara con un margen
// para que 7/20 cuente como 0,35.
const EPS = 1e-9

/** Si la barra está más allá del umbral: desde θ del lado long, hasta −θ del lado short. */
export function beyondThreshold({ from, to }: HistogramBin, theta: number): boolean {
  return from >= theta - EPS || to <= -theta + EPS
}

/** Cuántas decisiones pasaron el umbral (en cualquiera de los dos lados) y cuántas hubo. */
export function thresholdShare(bins: readonly HistogramBin[], theta: number): { beyond: number; total: number } {
  let beyond = 0
  let total = 0
  for (const bin of bins) {
    total += bin.count
    if (beyondThreshold(bin, theta)) beyond += bin.count
  }
  return { beyond, total }
}
