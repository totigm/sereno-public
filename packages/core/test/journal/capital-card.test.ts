import { describe, expect, it } from 'vitest'
import { capitalCard } from '../../src/journal/capital-card'
import { formatUsdWhole } from '../../src/journal/format'
import { snapshot } from './fixtures'

describe('formatUsdWhole', () => {
  it('a dólar entero; centavos sólo debajo de US$ 10', () => {
    expect(formatUsdWhole(1005.0215)).toBe('US$ 1.005')
    expect(formatUsdWhole(694.5)).toBe('US$ 695')
    expect(formatUsdWhole(1000)).toBe('US$ 1.000')
    expect(formatUsdWhole(9.5)).toBe('US$ 9,50')
    expect(formatUsdWhole(4)).toBe('US$ 4')
    expect(formatUsdWhole(9.996)).toBe('US$ 10')
    expect(formatUsdWhole(-312.4)).toBe('−US$ 312')
  })

  it('con ceil redondea para arriba, sin pasarse por ruido de coma flotante', () => {
    expect(formatUsdWhole(694.98, 'ceil')).toBe('US$ 695')
    expect(formatUsdWhole(694.02, 'ceil')).toBe('US$ 695')
    expect(formatUsdWhole(300.0000001, 'ceil')).toBe('US$ 300')
  })
})

describe('capitalCard', () => {
  it('"Tu capital" no muestra centavos: lo que falta va al entero de arriba', () => {
    const account = snapshot({ saldo: 1005.0215, equity: 1005.0215, capitalBase: 1005.0215, capitalOperable: 1005.0215, realizado: 5.0215 })
    const card = capitalCard({ account, protectPct: 0.7, shieldedAt: null, pausedByShield: false })
    expect(card.title).toBe('A US$ 695 de blindar los US$ 1.000 iniciales')
    expect(card.reinvest).toBe('sí · cada operación se calcula sobre US$ 1.005')
    const shielded = capitalCard({
      account: snapshot({ saldo: 1312.47, equity: 1312.47, protegido: 1000, capitalBase: 312.47, capitalOperable: 312.47, realizado: 312.47 }),
      protectPct: 0.7,
      shieldedAt: null,
      pausedByShield: false,
    })
    expect(shielded.detail).toBe('El bot opera con US$ 312.')
  })

  it('antes del blindaje: cuánto falta, progreso y reinversión', () => {
    const card = capitalCard({ account: snapshot(), protectPct: 0.7, shieldedAt: null, pausedByShield: false })
    expect(card.title).toBe('A US$ 452 de blindar los US$ 1.000 iniciales')
    expect(card.detail).toBe('Cuando la ganancia llegue a US$ 700 (70%), el bot sigue sólo con lo ganado.')
    expect(card.progress).toBeCloseTo(248 / 700, 10)
    expect(card.reinvest).toBe('sí · cada operación se calcula sobre US$ 1.248')
    expect(card.atRisk).toBeNull()
  })

  it('antes del blindaje la ganancia que cuenta es la menor entre realizada y de equity', () => {
    const card = capitalCard({
      account: snapshot({ saldo: 1248, equity: 1100, unrealized: -148, realizado: 248 }),
      protectPct: 0.7,
      shieldedAt: null,
      pausedByShield: false,
    })
    expect(card.title).toBe('A US$ 600 de blindar los US$ 1.000 iniciales')
    expect(card.progress).toBeCloseTo(100 / 700, 10)
  })

  it('con pérdida el progreso queda en cero y falta el objetivo entero', () => {
    const card = capitalCard({
      account: snapshot({ saldo: 950, equity: 950, realizado: -50, capitalBase: 950 }),
      protectPct: 0.7,
      shieldedAt: null,
      pausedByShield: false,
    })
    expect(card.title).toBe('A US$ 750 de blindar los US$ 1.000 iniciales')
    expect(card.progress).toBe(0)
  })

  it('sin base para blindar el progreso queda en cero en vez de NaN', () => {
    const card = capitalCard({
      account: snapshot({ saldo: 0, equity: 0, baseBlindaje: 0, capitalBase: 0, realizado: 0 }),
      protectPct: 0.7,
      shieldedAt: null,
      pausedByShield: false,
    })
    expect(card.progress).toBe(0)
  })

  it('sin reinversión', () => {
    const card = capitalCard({ account: snapshot({ reinvest: false, capitalBase: 1000 }), protectPct: 0.7, shieldedAt: null, pausedByShield: false })
    expect(card.reinvest).toBe('no · siempre sobre US$ 1.000')
  })

  it('blindado: fecha y con cuánto opera', () => {
    const account = snapshot({ saldo: 1312, equity: 1312, protegido: 1000, capitalBase: 312, capitalOperable: 312, realizado: 312 })
    const card = capitalCard({ account, protectPct: 0.7, shieldedAt: Date.UTC(2026, 9, 20, 15), pausedByShield: false })
    expect(card.title).toBe('Blindaste los US$ 1.000 iniciales el 20 de octubre.')
    expect(card.detail).toBe('El bot opera con US$ 312.')
    expect(card.progress).toBe(1)
    expect(card.reinvest).toBe('sí · cada operación se calcula sobre US$ 312')
    expect(card.atRisk).toBeNull()
  })

  it('blindado sin reinversión: no aplica; con las abiertas pasadas del colchón: capital en riesgo', () => {
    const account = snapshot({
      saldo: 1312, equity: 1312, protegido: 1000, capitalBase: 312, capitalOperable: 0, margenEnUso: 400, realizado: 312, reinvest: false,
    })
    const card = capitalCard({ account, protectPct: 0.7, shieldedAt: null, pausedByShield: false })
    expect(card.title).toBe('Blindaste los US$ 1.000 iniciales.')
    expect(card.reinvest).toBe('no aplica mientras el capital esté blindado')
    expect(card.atRisk).toBe('capital blindado en riesgo: US$ 88')
  })

  it('blindado y pausado solo', () => {
    const account = snapshot({ saldo: 1004, equity: 1004, protegido: 1000, capitalBase: 4, capitalOperable: 4, realizado: 4 })
    const card = capitalCard({ account, protectPct: 0.7, shieldedAt: Date.UTC(2026, 9, 20, 15), pausedByShield: true })
    expect(card.title).toBe('El bot se pausó: los US$ 1.000 están blindados y no queda ganancia para operar.')
    expect(card.detail).toBe('Podés volver a usar el capital blindado para que siga operando.')
  })

  it('después de volver a usar el capital blindado, la base nueva no se llama inicial', () => {
    const account = snapshot({ saldo: 1312, equity: 1312, baseBlindaje: 1312, capitalBase: 1312, capitalOperable: 1312, realizado: 312 })
    const card = capitalCard({ account, protectPct: 0.7, shieldedAt: null, pausedByShield: false })
    // Sin centavos: lo que falta y el objetivo (918,40) van al entero de arriba.
    expect(card.title).toBe('A US$ 919 de blindar US$ 1.312')
    expect(card.detail).toBe('Cuando la ganancia nueva llegue a US$ 919 (70%), el bot sigue sólo con lo ganado.')
    expect(card.progress).toBe(0)
  })

  it('blindaje apagado', () => {
    const card = capitalCard({ account: snapshot(), protectPct: 0, shieldedAt: null, pausedByShield: false })
    expect(card.title).toBe('Sin blindaje: el bot opera con todo el capital (US$ 1.248).')
    expect(card.detail).toBe('Activá el blindaje en Ajustes para guardar el capital inicial.')
    expect(card.progress).toBeNull()
  })
})
