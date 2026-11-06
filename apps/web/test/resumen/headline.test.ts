import { describe, expect, it, vi } from 'vitest'
import { pastHeadline, presentHeadline, type HeadlineParts } from '@/components/resumen/headline-model'
import { secondaryParts } from '@/components/resumen/secondary-line'
import type { HeadlineView } from '@/lib/derive'
import { formatUsd } from '@/lib/format'
import { BOT } from '../nav/fixtures'

// El titular partido alrededor del número y la línea secundaria (spec §11.1).

vi.mock('@/lib/db', () => ({ db: {}, repos: {} }))

function view(patch: Partial<HeadlineView> = {}): HeadlineView {
  return {
    equity: 1247.8,
    total: 247.8,
    realized: 247.8,
    unrealized: 0,
    today: 38.2,
    signsDiffer: false,
    offline: false,
    valuedAt: null,
    marksIncomplete: false,
    hasTrades: true,
    closedCount: 23,
    wonCount: 14,
    text: 'Vas ganando US$ 247,80 desde el 14 de octubre.',
    verdict: null,
    ...patch,
  }
}

const sentence = (p: HeadlineParts) => `${p.before}${p.amount === null ? '' : formatUsd(p.amount)}${p.after}`

describe('presentHeadline', () => {
  it('parte la frase de core en el monto, con el tono del total', () => {
    const parts = presentHeadline(view(), BOT)
    expect(parts).toMatchObject({ key: 'ganando', before: 'Vas ganando ', amount: 247.8, after: ' desde el 14 de octubre.', tone: 'gain', stale: false })
  })

  it('perdiendo: el monto va sin signo y en tono de pérdida', () => {
    const parts = presentHeadline(view({ total: -31.2, realized: -31.2, text: 'Vas perdiendo US$ 31,20 desde el 14 de octubre.' }), BOT)
    expect(parts).toMatchObject({ key: 'perdiendo', amount: 31.2, tone: 'loss' })
    expect(sentence(parts)).toBe('Vas perdiendo US$ 31,20 desde el 14 de octubre.')
  })

  it('con los signos cruzados el monto destacado es el total, no el de las abiertas', () => {
    const text = 'Vas ganando US$ 195,70, aunque las abiertas van perdiendo US$ 52,10.'
    const parts = presentHeadline(view({ total: 195.7, realized: 247.8, unrealized: -52.1, text }), BOT)
    expect(parts.amount).toBe(195.7)
    expect(parts.after).toBe(', aunque las abiertas van perdiendo US$ 52,10.')
  })

  it('sin conexión y con abiertas el monto va apagado', () => {
    expect(presentHeadline(view({ offline: true, valuedAt: 1 }), BOT).stale).toBe(true)
  })

  it('sin operaciones cuenta en qué anda el bot', () => {
    const empty = view({ hasTrades: false, total: 0, closedCount: 0, wonCount: 0, text: 'Todavía no abrí ninguna operación.' })
    expect(presentHeadline(empty, null).before).toBe('Simulación lista.')
    expect(presentHeadline(empty, { ...BOT, phase: 'warming', warmProgress: 18 }).before).toBe('Calentando · 18 de 30 monedas.')
    expect(presentHeadline(empty, BOT).before).toBe('Mirando el mercado. Todavía no abrí ninguna operación.')
    expect(presentHeadline({ ...empty, offline: true }, BOT).before).toBe('Todavía no abrí ninguna operación.')
  })
})

describe('pastHeadline', () => {
  it('replay: "Hubiera ganado US$ 412,30 en 90 días."', () => {
    const parts = pastHeadline(view({ total: 412.3, realized: 412.3 }), { replay: true, days: 90 })
    expect(sentence(parts)).toBe('Hubiera ganado US$ 412,30 en 90 días.')
  })

  it('archivada: "Perdió US$ 31,20 en 6 días."', () => {
    const parts = pastHeadline(view({ total: -31.2, realized: -31.2 }), { replay: false, days: 6.3 })
    expect(sentence(parts)).toBe('Perdió US$ 31,20 en 6 días.')
  })

  it('si las abiertas al final iban para el otro lado, lo dice sin perder los días', () => {
    const parts = pastHeadline(view({ total: 195.7, realized: 247.8, unrealized: -52.1 }), { replay: true, days: 90 })
    expect(sentence(parts)).toBe('Hubiera ganado US$ 195,70 en 90 días, aunque las abiertas al final iban perdiendo US$ 52,10.')
  })

  it('si lo cerrado iba para el otro lado, también', () => {
    const parts = pastHeadline(view({ total: -12.4, realized: 30, unrealized: -42.4 }), { replay: false, days: 6 })
    expect(sentence(parts)).toBe('Perdió US$ 12,40 en 6 días, aunque lo cerrado iba ganando US$ 30,00.')
  })

  it('sin operaciones', () => {
    expect(pastHeadline(view({ hasTrades: false, total: 0 }), { replay: true, days: 90 }).before).toBe('No hubiera abierto ninguna operación en 90 días.')
    expect(pastHeadline(view({ hasTrades: false, total: 0 }), { replay: false, days: 0.5 }).before).toBe('No abrió ninguna operación en menos de un día.')
  })
})

describe('secondaryParts', () => {
  const text = (parts: ReturnType<typeof secondaryParts>) => parts.map((p) => (p.value === null ? p.label : `${p.label} ${p.value}`)).join(' · ')

  it('"Cerrado +247,80 · abierto −52,10 · hoy +38,20 · 14 de 23 ganados"', () => {
    const parts = secondaryParts(view({ total: 195.7, realized: 247.8, unrealized: -52.1 }), { past: false, openCount: 3, pricesAt: null })
    expect(text(parts)).toBe('Cerrado +247,80 · abierto −52,10 · hoy +38,20 · 14 de 23 ganados')
    expect(parts.map((p) => p.tone)).toEqual(['gain', 'loss', 'gain', 'ink'])
  })

  it('sin conexión: lo que depende del precio va apagado, con la hora', () => {
    const at = Date.UTC(2026, 9, 31, 17, 32)
    const parts = secondaryParts(view({ unrealized: -52.1 }), { past: false, openCount: 3, pricesAt: at })
    expect(parts.find((p) => p.key === 'open')?.tone).toBe('muted')
    expect(parts.find((p) => p.key === 'today')?.tone).toBe('muted')
    expect(parts.at(-1)?.label).toBe('precios de las 14:32')
  })

  it('en pasado no hay "hoy" y las abiertas son "al final"', () => {
    const parts = secondaryParts(view({ unrealized: -52.1 }), { past: true, openCount: 2, pricesAt: null })
    expect(text(parts)).toBe('Cerrado +247,80 · abierto al final −52,10 · 14 de 23 ganados')
  })
})
