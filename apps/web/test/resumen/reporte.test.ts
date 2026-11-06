import { describe, expect, it, vi } from 'vitest'
import {
  binLabel,
  fortnightLabel,
  missingSignalText,
  pairLabel,
  reportCaveats,
  thresholdShare,
  universeChangeText,
  universeSummary,
} from '@/components/resumen/report-text'
import { resumenReportView } from '@/lib/queries/resumen-report'
import { NOW } from '../nav/fixtures'
import { replayReport } from './fixtures'

// El reporte de un replay (spec §9) como lo muestra Resumen: lo que el bot dejó en
// `sessions.report`, ordenado para leer, y sus textos.

vi.mock('@/lib/db', () => ({ db: {}, repos: {} }))

const day = (month: number, d: number) => Date.UTC(2026, month - 1, d)

describe('resumenReportView', () => {
  const view = resumenReportView(replayReport(), 0.35)

  it('las quincenas, el histograma y el umbral, tal cual', () => {
    expect(view.fortnights.map((f) => [f.trades, f.wins, f.pnlNet])).toEqual([
      [12, 7, 45.2],
      [9, 3, -18.6],
    ])
    expect(view.histogram).toHaveLength(40)
    expect(view.theta).toBe(0.35)
  })

  it('las señales que faltaron: por señal, con las monedas y los días seguidos juntos', () => {
    expect(view.missingSignals.map((m) => m.signal)).toEqual(['funding', 'openInterest', 'positioning'])
    const [funding, openInterest] = view.missingSignals
    expect(openInterest).toEqual({ signal: 'openInterest', coins: 3, ranges: [{ from: day(8, 2), to: day(9, 30) }] })
    // El 20 y el 21 de agosto son días seguidos: un solo tramo; el 5 de septiembre, otro.
    expect(funding).toEqual({
      signal: 'funding',
      coins: 1,
      ranges: [
        { from: day(8, 20), to: day(8, 21) },
        { from: day(9, 5), to: day(9, 5) },
      ],
    })
  })

  it('la correlación: los 45 pares, del más parecido (|ρ|) al menos y sin dato al final', () => {
    expect(view.pairs).toHaveLength(45)
    expect(view.pairs.slice(0, 2)).toEqual([
      { a: 'trend15m', b: 'trendHigher', rho: 0.82, decisions: 12_400 },
      { a: 'momentum', b: 'breakout', rho: -0.4, decisions: 12_400 },
    ])
    expect(view.pairs.at(-1)).toEqual({ a: 'funding', b: 'positioning', rho: null, decisions: 0 })
  })

  it('el universo: cuántas por día, cuántas distintas, el primer día y los cambios', () => {
    expect(view.universe).toEqual({
      days: 3,
      min: 3,
      max: 3,
      distinct: 4,
      first: { day: day(8, 2), symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'] },
      changes: [{ day: day(8, 4), added: ['PEPEUSDT'], removed: ['SOLUSDT'] }],
    })
  })

  it('las advertencias: desde cuándo hay datos de futuros y las monedas sin precio de marca', () => {
    expect(view.caveats).toEqual({
      drawdownPause: null,
      shadowOppositeSideCandles: 0,
      futuresDataFrom: day(10, 1),
      markFallbackCoins: 1,
      failures: 0,
      skipped: [],
    })
  })

  it('con interés abierto y ratios desde el primer día (o sin ellos nunca), no hay advertencia de futuros', () => {
    const report = replayReport()
    const early = resumenReportView({ ...report, caveats: { ...report.caveats, futuresDataFrom: day(8, 2) + 3_600_000 } }, 0.35)
    expect(early.caveats.futuresDataFrom).toBeNull()
    const never = resumenReportView({ ...report, caveats: { ...report.caveats, futuresDataFrom: null } }, 0.35)
    expect(never.caveats.futuresDataFrom).toBeNull()
  })
})

describe('los textos del reporte', () => {
  const view = resumenReportView(replayReport(), 0.35)

  it('las fechas son los días UTC del replay: una quincena va del 2 al 16 de agosto', () => {
    expect(fortnightLabel({ from: day(8, 2), to: day(8, 17) }, NOW)).toBe('2 ago → 16 ago')
  })

  it('las señales que faltaron, con sus fechas', () => {
    const [funding, openInterest] = view.missingSignals
    expect(missingSignalText(openInterest!, NOW)).toBe('del 2 ago al 30 sep, en 3 monedas')
    expect(missingSignalText(funding!, NOW)).toBe('del 20 ago al 21 ago y el 5 sep, en 1 moneda')
    const many = { ...funding!, ranges: [...funding!.ranges, { from: day(9, 20), to: day(9, 22) }] }
    expect(missingSignalText(many, NOW)).toBe('en 3 tramos entre el 20 ago y el 22 sep, en 1 moneda')
    expect(missingSignalText(many, NOW, { full: true })).toBe('del 20 ago al 21 ago, el 5 sep y del 20 sep al 22 sep, en 1 moneda')
  })

  it('el sesgo de supervivencia va siempre primero, aunque el bot no haya dejado reporte', () => {
    const survivorship =
      'Las monedas salen de las que hoy cotizan en Binance: faltan las que dejaron de cotizar en el período, y eso puede hacer que el resultado se vea mejor de lo que hubiera sido (sesgo de supervivencia).'
    expect(reportCaveats(null, NOW)).toEqual([survivorship])
    expect(reportCaveats(view, NOW)).toEqual([
      survivorship,
      'Interés abierto y posicionamiento hay desde el 1 oct (Binance guarda 30 días): antes, esas dos señales faltan.',
      'En 1 moneda faltó a ratos el precio de marca: ahí stops, take profit y liquidaciones usaron el último precio.',
    ])
  })

  it('las demás advertencias, cuando las hay', () => {
    const caveats = reportCaveats(
      {
        ...view,
        caveats: {
          ...view.caveats,
          futuresDataFrom: null,
          markFallbackCoins: 0,
          drawdownPause: { at: day(9, 12) + 3_600_000, peak: 1200, equity: 1020 },
          shadowOppositeSideCandles: 120,
          failures: 2,
          skipped: ['FTMUSDT'],
        },
      },
      NOW,
    )
    expect(caveats.slice(1)).toEqual([
      'El 12 sep se pausó por drawdown (de US$ 1.200 a US$ 1.020): en un replay nadie reanuda, así que desde ahí no abrió más.',
      'Durante 120 velas los originales iban del lado contrario: ahí sus salidas son optimistas y la comparación con lo aprendido los favorece.',
      '2 operaciones del motor fallaron y se saltearon.',
      'Binance rechazó los datos de FTM: quedó fuera del universo.',
    ])
  })

  it('la correlación nombra el par', () => {
    expect(pairLabel('trend15m', 'trendHigher')).toBe('Tendencia de 15 minutos y tendencia mayor')
    expect(pairLabel('btcRegime', 'vwap')).toBe('Régimen de BTC y VWAP')
  })

  it('el universo, resumido y día por día', () => {
    expect(universeSummary(view.universe)).toBe('3 monedas cada día, 4 distintas en los 3 días.')
    expect(universeSummary({ ...view.universe, min: 28, max: 30, distinct: 34, days: 90 })).toBe('Entre 28 y 30 monedas por día, 34 distintas en los 90 días.')
    expect(universeSummary({ ...view.universe, distinct: 3 })).toBe('Las mismas 3 monedas todos los días.')
    expect(universeChangeText({ day: 0, added: ['PEPEUSDT'], removed: ['SOLUSDT'] })).toBe('Entró PEPE. Salió SOL.')
    expect(universeChangeText({ day: 0, added: ['PEPEUSDT', 'WIFUSDT'], removed: [] })).toBe('Entraron PEPE y WIF.')
  })

  it('el histograma: la barra y lo que pasó el umbral', () => {
    expect(binLabel({ from: 0.35, to: 0.4, count: 1 })).toBe('De 0,35 a 0,40')
    expect(binLabel({ from: -1, to: -0.95, count: 1 })).toBe('De −1 a −0,95')
    // Del lado long, las barras desde 0,35; del short, las que terminan en −0,35 o antes.
    expect(thresholdShare(view.histogram, 0.35)).toEqual({ beyond: 156, total: 380 })
  })
})
