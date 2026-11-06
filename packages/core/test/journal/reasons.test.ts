import { describe, expect, it } from 'vitest'
import { SIGNAL_IDS } from '../../src/types'
import { pickReasons, REASON_PHRASES, reasonSentence } from '../../src/journal/reasons'
import { composite, signal } from './fixtures'

describe('REASON_PHRASES', () => {
  it('cubre las diez señales en los dos sentidos, en minúscula y sin punto final', () => {
    for (const id of SIGNAL_IDS) {
      for (const side of ['long', 'short'] as const) {
        const text = REASON_PHRASES[id][side]
        expect(text, `${id}/${side}`).toMatch(/^([a-záéíóúñ]|BTC)/)
        expect(text.endsWith('.'), `${id}/${side}`).toBe(false)
      }
    }
  })
})

describe('pickReasons', () => {
  it('toma hasta dos señales que acompañan al lado, por |valor × peso| descendente', () => {
    const c = composite({
      signals: [signal('trend15m', 0.4), signal('breakout', 1), signal('vwap', 0.5), signal('funding', -0.5)],
      weights: { vwap: 1.5 },
    })
    expect(pickReasons(c, 'long')).toEqual(['breakout', 'vwap'])
    expect(pickReasons(c, 'short')).toEqual(['funding'])
  })

  it('ignora señales ausentes y en cero', () => {
    const c = composite({ signals: [signal('trend15m', null), signal('bands', 0), signal('momentum', 0.1)] })
    expect(pickReasons(c, 'long')).toEqual(['momentum'])
  })

  it('una señal con peso efectivo cero no aportó nada y no es razón', () => {
    const c = composite({ signals: [signal('funding', 0.5), signal('vwap', 0.5)], weights: { funding: 0 } })
    expect(pickReasons(c, 'long')).toEqual(['vwap'])
  })

  it('el orden es estable ante empates: gana la que viene primero en el compuesto', () => {
    const c = composite({ signals: [signal('vwap', 0.5), signal('trend15m', 0.5), signal('bands', 0.5)] })
    expect(pickReasons(c, 'long')).toEqual(['vwap', 'trend15m'])
  })
})

describe('reasonSentence', () => {
  it('capitaliza, une con "y" y cierra con punto', () => {
    expect(reasonSentence(['trendHigher', 'funding'], 'long')).toBe('La tendencia en 1h y 4h acompaña y el funding está negativo.')
    expect(reasonSentence(['btcRegime'], 'short')).toBe('BTC está en tendencia bajista.')
    expect(reasonSentence([], 'long')).toBe('Las señales en conjunto dieron para entrar.')
  })
})
