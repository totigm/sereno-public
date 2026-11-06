import { describe, it, expect } from 'vitest'
import { realizedVol } from '../../src/indicators/realized-vol'
import { BTC_15M_CANDLES_FOR_BASELINE, buildBtcContext } from '../../src/market/btc-context'
import { CandleSeries } from '../../src/market/candle-series'
import type { BtcContext, Candle } from '../../src/types'
import { TF_MS, candleRun, utc } from './fixtures'

const VELAS_DIA = 96
const DIAS = 30
const t = utc(10, 15)

// Serie de 15m de BTC con estos cierres; la última es la vela 10:00–10:14:59.999, la última
// cerrada a las 10:15. `extra` agrega velas posteriores a t.
function serieBtc(closes: readonly number[], extra: readonly Candle[] = []): CandleSeries {
  const s = new CandleSeries('15m')
  const first = utc(10, 0) - (closes.length - 1) * TF_MS['15m']
  for (const c of candleRun('15m', first, closes.length, (i) => closes[i] as number)) s.upsert(c)
  for (const c of extra) s.upsert(c)
  return s
}

const contexto = (btc15m: CandleSeries): BtcContext => buildBtcContext({ t, btc4h: new CandleSeries('4h'), btc15m, warmup4h: 300 })

const planos = (n: number): number[] => Array.from({ length: n }, () => 1)

// Escribe en `closes`, desde `start`, una ventana de 96 retornos alternados +b, −b: cierres
// 1, e^b, 1, e^b, …, 1 (97 cierres; el primero y el último quedan en 1, así que las ventanas
// vecinas siguen planas).
function alternar(closes: number[], start: number, b: number): number[] {
  for (let k = 0; k <= VELAS_DIA; k++) closes[start + k] = k % 2 === 0 ? 1 : Math.exp(b)
  return closes
}

// Vol diaria de 96 retornos ±b (48 de cada signo, media 0), a mano:
// Σr² = 96·b², desvío muestral = √(96·b² / 95) = b·√(96/95); × √96 ⇒ 96·b / √95.
const volAlternada = (b: number): number => (96 * b) / Math.sqrt(95)

// Índice del primer cierre de la ventana de 24h dentro de una serie de 2881 cierres.
const INICIO_ULTIMA = BTC_15M_CANDLES_FOR_BASELINE - 1 - VELAS_DIA

describe('buildBtcContext: volatilidad realizada de BTC sobre 15m', () => {
  it('la ventana de 24h son 96 retornos: null con 96 cierres, número con 97', () => {
    expect(contexto(serieBtc(planos(VELAS_DIA))).realizedVol24h).toBeNull()
    expect(contexto(serieBtc(planos(VELAS_DIA + 1))).realizedVol24h).toBe(0)
  })

  it('la media de 30 días son 30 × 96 retornos: null con 2880 cierres, número con 2881', () => {
    expect(BTC_15M_CANDLES_FOR_BASELINE).toBe(2881)
    const casi = contexto(serieBtc(planos(VELAS_DIA * DIAS)))
    expect(casi.realizedVol24h).toBe(0)
    expect(casi.realizedVol30dMean).toBeNull()
    expect(contexto(serieBtc(planos(VELAS_DIA * DIAS + 1))).realizedVol30dMean).toBe(0)
  })

  it('realizedVol24h es diaria (× √96, no anualizada): 96 retornos ±0,01 dan 0,0984939…', () => {
    const btc = contexto(serieBtc(alternar(planos(BTC_15M_CANDLES_FOR_BASELINE), INICIO_ULTIMA, 0.01)))
    expect(volAlternada(0.01)).toBeCloseTo(0.0984939218, 10)
    expect(btc.realizedVol24h).toBeCloseTo(volAlternada(0.01), 12)
    // Las otras 29 ventanas son planas: media = v / 30, en la misma escala diaria.
    expect(btc.realizedVol30dMean).toBeCloseTo(volAlternada(0.01) / DIAS, 12)
  })

  it('la media usa exactamente las 30 ventanas alineadas a la última e ignora cierres más viejos', () => {
    // 2881 cierres útiles precedidos por 50 muy volátiles que no deben contar. La ventana más
    // vieja (cierres 0…96 de los útiles) alterna ±0,02, la más nueva ±0,01 y las 28 del medio
    // son planas ⇒ media = (96·0,01 + 96·0,02) / √95 / 30.
    const utiles = alternar(alternar(planos(BTC_15M_CANDLES_FOR_BASELINE), 0, 0.02), INICIO_ULTIMA, 0.01)
    const viejos = Array.from({ length: 50 }, (_, i) => (i % 2 === 0 ? 50 : 200))
    const btc = contexto(serieBtc([...viejos, ...utiles]))
    expect(btc.realizedVol24h).toBeCloseTo(volAlternada(0.01), 12)
    expect(btc.realizedVol30dMean).toBeCloseTo((volAlternada(0.01) + volAlternada(0.02)) / DIAS, 12)
    expect(btc.realizedVol30dMean).toBeCloseTo(0.0098493922, 10)
  })

  it('realizedVol24h es el último valor de indicators/realizedVol(cierres, 96)', () => {
    const closes = Array.from({ length: 400 }, (_, i) => 100 * Math.exp(0.01 * Math.sin(i / 3) + 0.002 * Math.cos(i * 1.7)))
    const btc = contexto(serieBtc(closes))
    expect(btc.realizedVol24h).toBeCloseTo(realizedVol(closes, VELAS_DIA).at(-1) as number, 12)
  })

  it('un cierre no positivo en la ventana de 24h la deja en null, nunca NaN; la media sigue con las otras 29', () => {
    const closes = planos(BTC_15M_CANDLES_FOR_BASELINE)
    closes[BTC_15M_CANDLES_FOR_BASELINE - 10] = 0
    const btc = contexto(serieBtc(closes))
    expect(btc.realizedVol24h).toBeNull()
    expect(btc.realizedVol30dMean).toBe(0)
  })

  // Rompe la ventana `dia` (0 = la de 24h) con un cierre en 0 en su mitad: sus dos
  // retornos quedan adentro, así que las ventanas vecinas siguen sanas.
  function romper(closes: number[], ...dias: number[]): number[] {
    for (const dia of dias) closes[BTC_15M_CANDLES_FOR_BASELINE - 1 - dia * VELAS_DIA - VELAS_DIA / 2] = 0
    return closes
  }
  const conUltimaAlternada = (): number[] => alternar(planos(BTC_15M_CANDLES_FOR_BASELINE), INICIO_ULTIMA, 0.01)

  it('una ventana mala no apaga la media: promedia las 29 finitas', () => {
    const btc = contexto(serieBtc(romper(conUltimaAlternada(), 5)))
    expect(btc.realizedVol24h).toBeCloseTo(volAlternada(0.01), 12)
    expect(btc.realizedVol30dMean).toBeCloseTo(volAlternada(0.01) / 29, 12)
  })

  it('con 27 ventanas finitas todavía hay media; con 26 es null', () => {
    expect(contexto(serieBtc(romper(conUltimaAlternada(), 3, 11, 29))).realizedVol30dMean).toBeCloseTo(volAlternada(0.01) / 27, 12)
    expect(contexto(serieBtc(romper(conUltimaAlternada(), 3, 11, 20, 29))).realizedVol30dMean).toBeNull()
  })

  it('las ventanas terminan en t: ignora velas de BTC posteriores a t', () => {
    const futuras = candleRun('15m', utc(10, 15), 4, (i) => (i % 2 === 0 ? 50 : 200)) // 10:15 … 11:00, muy volátiles
    const btc = contexto(serieBtc(planos(BTC_15M_CANDLES_FOR_BASELINE), futuras))
    expect(btc.realizedVol24h).toBe(0)
    expect(btc.realizedVol30dMean).toBe(0)
  })
})
