import { DEFAULT_SETTINGS } from '@sereno/shared'
import { describe, expect, it, vi } from 'vitest'
import {
  boardHeadline,
  confidenceSentence,
  decisionSentence,
  exclusionText,
  leanSentence,
  stateSentence,
  statsSentence,
  tileStateText,
} from '@/components/monedas/phrases'
import { boardTiles } from '@/components/monedas/tile-model'
import { withExcluded, withPinned } from '@/components/monedas/universe'
import { NOW } from '../nav/fixtures'
import { coinInfo, market, OPEN, WIF_BACK } from './fixtures'

// Las fixtures arman las sesiones con `toSessionView` (puro); el módulo trae la base, que acá no hace falta.
vi.mock('@/lib/db', () => ({ db: {}, repos: {} }))

const MINUTE = 60_000

describe('textos de estado de la baldosa', () => {
  it('enfriamiento en minutos y horas, redondeando para arriba', () => {
    expect(tileStateText({ kind: 'cooldown', until: NOW + 75 * MINUTE }, NOW, false)).toBe('espera 1 h 15 min')
    expect(tileStateText({ kind: 'cooldown', until: NOW + 60 * MINUTE }, NOW, false)).toBe('espera 1 h')
    expect(tileStateText({ kind: 'cooldown', until: NOW + 20_000 }, NOW, false)).toBe('espera 1 min')
    expect(tileStateText({ kind: 'cooldown', until: null }, NOW, false)).toBe('en enfriamiento')
  })

  it('degradada: sin la antigüedad mientras es de hace menos de un minuto', () => {
    expect(tileStateText({ kind: 'degraded', since: NOW - 20_000 }, NOW, false)).toBe('sin datos')
    expect(tileStateText({ kind: 'degraded', since: NOW - 2 * 3_600_000 }, NOW, false)).toBe('sin datos hace 2 h')
  })

  it('en pasado para un replay o una simulación archivada', () => {
    expect(tileStateText({ kind: 'cooldown', until: NOW + 45 * MINUTE }, NOW, true)).toBe('esperaba 45 min')
    expect(tileStateText({ kind: 'penalized', until: WIF_BACK }, NOW, true)).toBe('volvía el 7/11')
    expect(tileStateText({ kind: 'degraded', since: NOW - 3 * MINUTE }, NOW, true)).toBe('sin datos desde las 15:29')
  })

  it('lista o con posición no lleva texto de estado', () => {
    expect(tileStateText({ kind: 'ready' }, NOW, false)).toBeNull()
    expect(tileStateText({ kind: 'position', side: 'long', leverage: 5, net: 1 }, NOW, false)).toBeNull()
  })
})

describe('modelo de las baldosas', () => {
  it('una abierta sin precio en el snapshot igual tiene baldosa', () => {
    const tiles = boardTiles(market((symbols) => symbols.filter((s) => s.symbol !== 'SOLUSDT')), OPEN)
    // Sin puntaje va última entre las abiertas.
    expect(tiles.slice(0, 3).map((t) => t.symbol)).toEqual(['ETHUSDT', 'AVAXUSDT', 'SOLUSDT'])
    expect(tiles[2]).toMatchObject({ name: 'SOL', markPrice: null, change24h: null, sPrime: null })
    expect(tiles[2]?.state).toEqual({ kind: 'position', side: 'long', leverage: 5, net: 12.4 })
  })

  it('el estado "con posición" del snapshot sin la abierta en la lista queda como lista', () => {
    const tiles = boardTiles(market(), [])
    expect(tiles.find((t) => t.symbol === 'SOLUSDT')?.state).toEqual({ kind: 'ready' })
  })
})

describe('titular', () => {
  it('singular, plural y sin abiertas', () => {
    expect(boardHeadline(1, 1, 'live')).toBe('Mirando 1 moneda, con 1 posición abierta.')
    expect(boardHeadline(30, 0, 'live')).toBe('Mirando 30 monedas, sin posiciones abiertas.')
    expect(boardHeadline(30, 2, 'archived')).toBe('Al archivar la simulación miraba 30 monedas, con 2 posiciones abiertas.')
  })
})

describe('frases de la hoja', () => {
  it('inclinación contra el umbral', () => {
    expect(leanSentence(0.72, 0.35, false)).toBe('Me inclino a long con +0,72: pasa el umbral de 0,35.')
    expect(leanSentence(-0.21, 0.35, false)).toBe('Me inclino a short con −0,21: no llega al umbral de 0,35.')
    expect(leanSentence(0.001, 0.35, false)).toBe('No me inclino para ningún lado.')
    expect(leanSentence(0.72, 0.35, true)).toBe('Me inclinaba a long con +0,72: pasaba el umbral de 0,35.')
    expect(leanSentence(null, 0.35, false)).toBe('Sin puntaje en el último ciclo.')
  })

  it('la última decisión, con la frase del diario para los bloqueos', () => {
    const decision = coinInfo('SOLUSDT').decision!
    expect(decisionSentence('SOLUSDT', { ...decision, action: 'enter_long' }, false)).toBe('Abrí un long en SOL.')
    expect(decisionSentence('1000PEPEUSDT', { ...decision, action: 'enter_short' }, false)).toBe('Abrí un short en PEPE.')
    expect(decisionSentence('SOLUSDT', decision, false)).toBe('Miré SOL y esperé: la inclinación no llega al umbral.')
    expect(decisionSentence('SOLUSDT', { ...decision, action: 'blocked:low_volume', blockedBy: 'low_volume' }, false)).toBe(
      'Miré SOL y esperé: la inclinación es fuerte pero el volumen no acompaña.',
    )
  })

  it('en un replay la espera se cuenta en pasado', () => {
    const decision = coinInfo('SOLUSDT').decision!
    expect(decisionSentence('SOLUSDT', decision, true)).toBe('Miré SOL y esperé: la inclinación no llegaba al umbral.')
    expect(decisionSentence('SOLUSDT', { ...decision, action: 'enter_long' }, true)).toBe('Abrí un long en SOL.')
  })

  it('confianza aprendida y tamaño', () => {
    expect(confidenceSentence(coinInfo('SOLUSDT'), false)).toBe('Todavía no cerré trades en SOL: confianza neutra y tamaño completo.')
    expect(confidenceSentence(coinInfo('WIFUSDT', { learnedTrades: 8, confidence: -0.45, multiplier: 0.55 }), false)).toBe(
      'Con 8 trades cerrados, confianza −0,45: abro con el 55% del tamaño.',
    )
    expect(confidenceSentence(coinInfo('SOLUSDT', { learnedTrades: 1, confidence: 0.2 }), true)).toBe(
      'Con 1 trade cerrado, confianza +0,20: abría con el tamaño completo.',
    )
  })

  it('estadísticas de la moneda', () => {
    expect(statsSentence({ trades: 6, wins: 4, pnlNet: 31.2, winRate: 4 / 6 }, 'SOL', false)).toBe(
      'Operé SOL 6 veces: 4 ganadas, +US$ 31,20 en total.',
    )
    expect(statsSentence({ trades: 1, wins: 0, pnlNet: -5, winRate: 0 }, 'SOL', false)).toBe(
      'Operé SOL una vez: ninguna ganada, −US$ 5,00 en total.',
    )
    expect(statsSentence(null, 'SOL', false)).toBe('Todavía no operé SOL.')
    expect(statsSentence(null, 'SOL', true)).toBe('No operé SOL.')
  })

  it('el estado de la moneda con su porqué', () => {
    expect(stateSentence({ kind: 'cooldown', until: NOW + 45 * MINUTE }, 'NEAR', NOW, false)).toBe(
      'Después de una pérdida dejo pasar unas velas: puedo volver a entrar en 45 min.',
    )
    expect(stateSentence({ kind: 'degraded', since: NOW - 3 * MINUTE }, 'FIL', NOW, false)).toBe(
      'Sin datos hace 3 min: no evalúo entradas en FIL hasta que vuelvan.',
    )
    expect(stateSentence({ kind: 'penalized', until: WIF_BACK }, 'WIF', NOW, true)).toBe('Estaba en penitencia hasta el 7 de noviembre.')
    expect(stateSentence({ kind: 'ready' }, 'BTC', NOW, false)).toBeNull()
  })
})

describe('fuera del tablero', () => {
  it('por qué no entró una fijada', () => {
    expect(exclusionText({ reason: 'tradfi', pinned: true }, 60)).toBe('Fijada, pero es TradFi y está apagado en Ajustes.')
    expect(exclusionText({ reason: 'history', detail: '2026-10-15', pinned: true }, 60)).toBe(
      'Fijada, pero se listó el 15 de octubre y necesita 60 días de historia.',
    )
    expect(exclusionText({ reason: 'no_contract', pinned: true }, 60)).toBe('Fijada, pero no existe en Binance.')
  })
})

describe('parches del universo', () => {
  const universe = { ...DEFAULT_SETTINGS.universe, pinned: ['BTCUSDT'], excluded: ['DOGEUSDT'] }

  it('fijar saca de las excluidas; dejar de fijar sólo saca de las fijadas', () => {
    expect(withPinned(universe, 'DOGEUSDT', true)).toEqual({ ...universe, pinned: ['BTCUSDT', 'DOGEUSDT'], excluded: [] })
    expect(withPinned(universe, 'BTCUSDT', false)).toEqual({ ...universe, pinned: [] })
    // Fijar dos veces no la repite.
    expect(withPinned(universe, 'BTCUSDT', true).pinned).toEqual(['BTCUSDT'])
  })

  it('excluir saca de las fijadas; incluir sólo saca de las excluidas', () => {
    expect(withExcluded(universe, 'BTCUSDT', true)).toEqual({ ...universe, pinned: [], excluded: ['DOGEUSDT', 'BTCUSDT'] })
    expect(withExcluded(universe, 'DOGEUSDT', false)).toEqual({ ...universe, excluded: [] })
  })
})
