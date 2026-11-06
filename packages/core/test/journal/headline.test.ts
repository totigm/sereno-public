import { describe, expect, it } from 'vitest'
import { headline } from '../../src/journal/headline'

const since = 'el 14 de octubre'

describe('headline', () => {
  it('ganando, perdiendo e igual', () => {
    expect(headline({ total: 247.8, realized: 200, unrealized: 47.8, sinceLabel: since, hasTrades: true })).toBe(
      'Vas ganando US$ 247,80 desde el 14 de octubre.',
    )
    expect(headline({ total: -31.2, realized: -31.2, unrealized: 0, sinceLabel: since, hasTrades: true })).toBe(
      'Vas perdiendo US$ 31,20 desde el 14 de octubre.',
    )
    expect(headline({ total: 0.004, realized: 0.004, unrealized: 0, sinceLabel: since, hasTrades: true })).toBe(
      'Estás igual que el 14 de octubre.',
    )
    expect(headline({ total: 12, realized: 12, unrealized: 0, sinceLabel: 'hoy a las 10:15', hasTrades: true })).toBe(
      'Vas ganando US$ 12,00 desde hoy a las 10:15.',
    )
  })

  it('sin trades', () => {
    expect(headline({ total: 0, realized: 0, unrealized: 0, sinceLabel: since, hasTrades: false })).toBe(
      'Todavía no abrí ninguna operación.',
    )
    expect(headline({ total: 0, realized: 0, unrealized: 0, sinceLabel: since, hasTrades: false, offline: { at: '14:32' } })).toBe(
      'Todavía no abrí ninguna operación.',
    )
  })

  it('signos distintos: frase exacta del brief y su espejo', () => {
    expect(headline({ total: 195.7, realized: 247.8, unrealized: -52.1, sinceLabel: since, hasTrades: true })).toBe(
      'Vas ganando US$ 195,70, aunque las abiertas van perdiendo US$ 52,10.',
    )
    expect(headline({ total: -20, realized: -60, unrealized: 40, sinceLabel: since, hasTrades: true })).toBe(
      'Vas perdiendo US$ 20,00, aunque las abiertas van ganando US$ 40,00.',
    )
    expect(headline({ total: 195.7, realized: -52.1, unrealized: 247.8, sinceLabel: since, hasTrades: true })).toBe(
      'Vas ganando US$ 195,70, aunque lo cerrado va perdiendo US$ 52,10.',
    )
  })

  it('un componente opuesto que redondea a cero no merece el "aunque"', () => {
    expect(headline({ total: 195.7, realized: 195.703, unrealized: -0.003, sinceLabel: since, hasTrades: true })).toBe(
      'Vas ganando US$ 195,70 desde el 14 de octubre.',
    )
  })

  it('sin conexión aclara con qué precios se valuaron las abiertas', () => {
    expect(headline({ total: 247.8, realized: 200, unrealized: 47.8, sinceLabel: since, hasTrades: true, offline: { at: '14:32' } })).toBe(
      'Vas ganando US$ 247,80 desde el 14 de octubre, con las abiertas valuadas a las 14:32.',
    )
    expect(headline({ total: 0, realized: 10, unrealized: -10, sinceLabel: since, hasTrades: true, offline: { at: '14:32' } })).toBe(
      'Estás igual que el 14 de octubre, con las abiertas valuadas a las 14:32.',
    )
    expect(headline({ total: 195.7, realized: 247.8, unrealized: -52.1, sinceLabel: since, hasTrades: true, offline: { at: '14:32' } })).toBe(
      'Vas ganando US$ 195,70, aunque las abiertas van perdiendo US$ 52,10 (valuadas a las 14:32).',
    )
    expect(headline({ total: 195.7, realized: -52.1, unrealized: 247.8, sinceLabel: since, hasTrades: true, offline: { at: '14:32' } })).toBe(
      'Vas ganando US$ 195,70, aunque lo cerrado va perdiendo US$ 52,10, con las abiertas valuadas a las 14:32.',
    )
  })
})
