import type { AccountSnapshot } from '@sereno/core'
import { describe, expect, it, vi } from 'vitest'
import { pastCapitalCard } from '@/components/resumen/capital-text'
import { releaseText } from '@/lib/release-text'
import { capitalInput, originOptions, protectOptions } from '@/components/resumen/first-run-model'
import { parseCapital } from '@/lib/amount'
import { journalLine, journalSummary, liquidationBandText } from '@/components/resumen/journal-text'
import { journal, journalEntry } from './fixtures'

// Las frases de Resumen que no vienen hechas de core (spec §11.1).

vi.mock('@/lib/db', () => ({ db: {}, repos: {} }))

describe('journalSummary', () => {
  it('"Desde ayer: 4 operaciones, 3 ganadas, +US$ 22,10. Miré 30 monedas 32 veces."', () => {
    expect(journalSummary(journal(), { past: false })).toBe('Desde ayer: 4 operaciones, 3 ganadas, +US$ 22,10. Miré 30 monedas 32 veces.')
  })

  it('en pasado nombra el día y sin cierres lo dice', () => {
    const quiet = journal([], { trades: 0, won: 0, pnl: 0, cycles: 0, coins: 0 })
    expect(journalSummary(quiet, { past: true })).toBe('Desde el 30 de octubre: ninguna operación cerrada.')
  })

  it('una sola, ninguna ganada', () => {
    expect(journalSummary(journal([], { trades: 1, won: 0, pnl: -4.5, cycles: 1, coins: 1 }), { past: false })).toBe(
      'Desde ayer: 1 operación, ninguna ganada, −US$ 4,50. Miré 1 moneda 1 vez.',
    )
  })

  it('la banda de liquidaciones', () => {
    expect(liquidationBandText(1)).toBe('Hubo 1 liquidación desde ayer.')
    expect(liquidationBandText(2)).toBe('Hubo 2 liquidaciones desde ayer.')
  })
})

describe('diario con números de Binance', () => {
  it('una entrada con datos de Binance lo dice al final', () => {
    const close = journalEntry('close:pos_btc', { kind: 'close', text: 'Cerré el long en BTC en el take profit: +US$ 1,20 (+0,8R).', reported: true })
    expect(journalLine(close)).toBe('Cerré el long en BTC en el take profit: +US$ 1,20 (+0,8R) · datos de Binance')
  })

  it('una diferencia de reconciliación se lee tal cual', () => {
    const phrase = 'Binance cerró el short en ETH y la base lo tenía abierto: lo registré con el fill real.'
    expect(journalLine(journalEntry('real:7', { kind: 'real', text: phrase, highlight: true }))).toBe(phrase)
  })

  it('en papel no cambia', () => {
    const open = journalEntry('open:pos_sol')
    expect(journalLine(open)).toBe(open.text)
  })
})

function account(patch: Partial<AccountSnapshot> = {}): AccountSnapshot {
  return {
    capitalInicial: 1000,
    saldo: 1248,
    equity: 1248,
    protegido: 0,
    baseBlindaje: 1000,
    capitalBase: 1248,
    capitalOperable: 1248,
    margenEnUso: 0,
    realizado: 248,
    unrealized: 0,
    reinvest: true,
    ...patch,
  }
}

describe('pastCapitalCard', () => {
  it('sin centavos: lo que faltaba va al entero de arriba', () => {
    const card = pastCapitalCard({
      account: account({ saldo: 1005.0215, equity: 1005.0215, capitalBase: 1005.0215, capitalOperable: 1005.0215, realizado: 5.0215 }),
      protectPct: 0.7,
      shieldedAt: null,
      pausedByShield: false,
    })
    expect(card.title).toBe('Quedó a US$ 695 de blindar los US$ 1.000 iniciales.')
    expect(card.reinvest).toBe('sí · cada operación se calculaba sobre US$ 1.005')
  })

  it('antes de blindar, en pasado', () => {
    const card = pastCapitalCard({ account: account(), protectPct: 0.7, shieldedAt: null, pausedByShield: false })
    expect(card.title).toBe('Quedó a US$ 452 de blindar los US$ 1.000 iniciales.')
    expect(card.detail).toBe('Blindaba cuando la ganancia llegara a US$ 700 (70%).')
    expect(card.progress).toBeCloseTo(248 / 700)
  })

  it('blindado, con la fecha y lo que operaba al final', () => {
    const card = pastCapitalCard({
      account: account({ protegido: 1000, capitalBase: 312, saldo: 1312, equity: 1312 }),
      protectPct: 0.7,
      shieldedAt: Date.UTC(2026, 9, 20, 15, 0),
      pausedByShield: false,
    })
    expect(card.title).toBe('Blindó los US$ 1.000 iniciales el 20 de octubre.')
    expect(card.detail).toBe('Al final operaba con US$ 312.')
  })

  it('blindado y pausado al final', () => {
    const card = pastCapitalCard({ account: account({ protegido: 1000, capitalBase: 4, saldo: 1004 }), protectPct: 0.7, shieldedAt: null, pausedByShield: true })
    expect(card.title).toBe('Terminó pausado: los US$ 1.000 estaban blindados y no quedaba ganancia para operar.')
  })

  it('la confirmación de volver a usar el capital', () => {
    expect(releaseText(1000, 1312, 0.7)).toBe(
      'Los US$ 1.000 blindados vuelven a operar. El blindaje vuelve a medir desde US$ 1.312: se dispara cuando ganes otros US$ 918,40 (70%).',
    )
  })
})

describe('primer uso', () => {
  it('lee el capital como se escribe acá', () => {
    expect(parseCapital('1000')).toBe(1000)
    expect(parseCapital('1.000')).toBe(1000)
    expect(parseCapital('US$ 2.500')).toBe(2500)
    expect(parseCapital('1.000,50')).toBe(1000.5)
    expect(parseCapital('1000.5')).toBe(1000.5)
    expect(parseCapital('')).toBeNull()
    expect(parseCapital('0')).toBeNull()
    expect(parseCapital('-5')).toBeNull()
    expect(parseCapital('mil')).toBeNull()
    expect(capitalInput(1000)).toBe('1.000')
  })

  it('las opciones del blindaje incluyen la de los ajustes por defecto', () => {
    expect(protectOptions(0.7).map((o) => o.label)).toEqual(['Sin blindaje', '50%', '70%', '100%'])
  })

  it('el paso 3 existe sólo con replays con aprendizaje', () => {
    expect(originOptions({ continued: true, replays: [] })).toEqual([])
    const options = originOptions({
      continued: true,
      replays: [{ id: 'rep_1', name: 'Replay · 90 días', days: 90, capitalInicial: 1000, endedAt: Date.UTC(2026, 9, 28, 15, 0) }],
    })
    expect(options.map((o) => o.value)).toEqual(['zero', 'continued', 'replay:rep_1'])
    expect(options[2]?.title).toBe('Lo aprendido en Replay · 90 días (terminó el 28 de octubre)')
  })
})
