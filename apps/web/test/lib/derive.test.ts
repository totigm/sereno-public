// @vitest-environment node
import { DEFAULT_SETTINGS } from '@sereno/shared'
import { describe, expect, it } from 'vitest'
import { deriveAccount, deriveCapitalCard, deriveHeadline, isOffline, valuePosition, type CapitalCardLive, type HeadlineSnapshot } from '@/lib/derive'
import { position } from '../fixtures'

const NOW = Date.UTC(2026, 9, 31, 18, 0) // 15:00 en Buenos Aires
const STARTED = Date.UTC(2026, 9, 14, 13, 0) // 14 de octubre

function snapshot(patch: Partial<HeadlineSnapshot> = {}): HeadlineSnapshot {
  return {
    capitalInicial: 1000,
    startedAt: STARTED,
    saldo: 1247.8,
    equityAtDayStart: 1157.5,
    closedCount: 23,
    wonCount: 14,
    lastHeartbeat: NOW - 5_000,
    marksAt: NOW - 2_000,
    verdict: { status: 'insufficient', reason: 'Con 23 operaciones en 17 días todavía no se puede saber si tiene ventaja; faltan 77 y 13 días.' },
    ...patch,
  }
}

// Dos abiertas que suman −52,10 a la marca: un long que pierde 60,10 y un short que gana 8.
// Sin comisiones pagadas, para que los números sean los de la spec §11.1.
const OPEN = [
  position('p1', { symbol: 'SOLUSDT', side: 'long', entryPrice: 150, qty: 10, feesPaid: 0 }),
  position('p2', { symbol: 'ETHUSDT', side: 'short', entryPrice: 2600, qty: 0.1, feesPaid: 0 }),
]
const MARKS = { SOLUSDT: 143.99, ETHUSDT: 2520 }

describe('deriveHeadline', () => {
  it('total = equity − I₀, con el realizado y el no realizado por separado', () => {
    const h = deriveHeadline(snapshot(), OPEN, MARKS, NOW)
    expect(h.total).toBeCloseTo(195.7, 9)
    expect(h.realized).toBeCloseTo(247.8, 9)
    expect(h.unrealized).toBeCloseTo(-52.1, 9)
    expect(h.signsDiffer).toBe(false)
    expect(h.offline).toBe(false)
    expect(h.text).toBe('Vas ganando US$ 195,70, aunque las abiertas van perdiendo US$ 52,10.')
  })

  it('trae la línea corta del veredicto que va debajo del titular', () => {
    expect(deriveHeadline(snapshot(), OPEN, MARKS, NOW).verdict).toEqual({
      status: 'insufficient',
      reason: 'Con 23 operaciones en 17 días todavía no se puede saber si tiene ventaja; faltan 77 y 13 días.',
    })
    expect(deriveHeadline(snapshot({ verdict: null }), OPEN, MARKS, NOW).verdict).toBeNull()
  })

  it('un realizado que se mostraría "US$ 0,00" no da signos distintos, igual que el titular', () => {
    // total −30, realizado +0,004: el titular no dice "aunque lo cerrado…".
    const h = deriveHeadline(snapshot({ saldo: 1000.004 }), [position('p1', { entryPrice: 150, qty: 10, feesPaid: 0 })], { SOLUSDT: 147 }, NOW)
    expect(h.signsDiffer).toBe(false)
    expect(h.text).toBe('Vas perdiendo US$ 30,00 desde el 14 de octubre.')
  })

  it('"hoy" es la equity de ahora menos la de las 00:00 de Buenos Aires', () => {
    expect(deriveHeadline(snapshot(), OPEN, MARKS, NOW).today).toBeCloseTo(38.2, 9)
  })

  it('signsDiffer cuando el total y lo cerrado van para lados distintos', () => {
    const h = deriveHeadline(snapshot({ saldo: 1020 }), [position('p1', { entryPrice: 150, qty: 10, feesPaid: 0 })], { SOLUSDT: 145 }, NOW)
    expect(h.realized).toBeCloseTo(20, 9)
    expect(h.unrealized).toBeCloseTo(-50, 9)
    expect(h.total).toBeCloseTo(-30, 9)
    expect(h.signsDiffer).toBe(true)
    expect(h.text).toBe('Vas perdiendo US$ 30,00, aunque lo cerrado va ganando US$ 20,00.')
  })

  it('sin conexión cuando el latido tiene 61 s; con 60 s todavía no', () => {
    expect(deriveHeadline(snapshot({ lastHeartbeat: NOW - 61_000 }), OPEN, MARKS, NOW).offline).toBe(true)
    expect(deriveHeadline(snapshot({ lastHeartbeat: NOW - 60_000 }), OPEN, MARKS, NOW).offline).toBe(false)
  })

  it('sin conexión el titular aclara a qué hora se valuaron las abiertas', () => {
    const h = deriveHeadline(snapshot({ lastHeartbeat: NOW - 600_000, marksAt: Date.UTC(2026, 9, 31, 17, 32) }), OPEN, MARKS, NOW)
    expect(h.valuedAt).toBe(Date.UTC(2026, 9, 31, 17, 32))
    expect(h.text).toBe('Vas ganando US$ 195,70, aunque las abiertas van perdiendo US$ 52,10 (valuadas a las 14:32).')
  })

  it('sin operaciones todavía', () => {
    const h = deriveHeadline(snapshot({ saldo: 1000, closedCount: 0, wonCount: 0, equityAtDayStart: 1000 }), [], {}, NOW)
    expect(h.hasTrades).toBe(false)
    expect(h.total).toBe(0)
    expect(h.text).toBe('Todavía no abrí ninguna operación.')
  })

  it('una abierta sin precio no suma y lo avisa', () => {
    const h = deriveHeadline(snapshot(), OPEN, { SOLUSDT: 143.99 }, NOW)
    expect(h.unrealized).toBeCloseTo(-60.1, 9)
    expect(h.marksIncomplete).toBe(true)
  })

  it('lo cerrado es la suma de pnlNet y lo abierto va neto de comisiones y funding: suma lo mismo que sus filas', () => {
    // Cerradas por +247,80 netos; las abiertas ya pagaron 0,25 + 0,10 de comisiones y 0,05 de
    // funding, que el saldo descontó antes de cerrarlas: saldo = 1.000 + 247,80 − 0,40.
    const open = [
      position('p1', { symbol: 'SOLUSDT', side: 'long', entryPrice: 150, qty: 10, feesPaid: 0.25, fundingPaid: 0.05 }),
      position('p2', { symbol: 'ETHUSDT', side: 'short', entryPrice: 2600, qty: 0.1, feesPaid: 0.1 }),
    ]
    const h = deriveHeadline(snapshot({ saldo: 1247.4 }), open, MARKS, NOW)
    const rows = open.map((p) => valuePosition(p, MARKS).net ?? Number.NaN)
    expect(h.realized).toBeCloseTo(247.8, 9)
    expect(h.unrealized).toBeCloseTo(-52.5, 9)
    expect(h.unrealized).toBeCloseTo(rows[0]! + rows[1]!, 9)
    expect(h.total).toBeCloseTo(h.realized + h.unrealized, 9)
    expect(h.equity).toBeCloseTo(1195.3, 9)
    expect(h.total).toBeCloseTo(195.3, 9)
    expect(h.text).toBe('Vas ganando US$ 195,30, aunque las abiertas van perdiendo US$ 52,50.')
  })

  it('lo ya pagado por una abierta sin precio queda en lo abierto: cerrado + abierto sigue siendo el total', () => {
    const open = [position('p1', { symbol: 'SOLUSDT', feesPaid: 0.4 })]
    const h = deriveHeadline(snapshot({ saldo: 1247.4 }), open, {}, NOW)
    expect(h.realized).toBeCloseTo(247.8, 9)
    expect(h.unrealized).toBeCloseTo(-0.4, 9)
    expect(h.total).toBeCloseTo(247.4, 9)
  })
})

describe('isOffline', () => {
  it('sin latido nunca cuenta como sin conexión', () => {
    expect(isOffline(null, NOW)).toBe(true)
  })
})

describe('valuePosition', () => {
  it('valúa a la marca, neto de lo pagado, en R y sobre el margen', () => {
    const v = valuePosition(position('p1', { feesPaid: 0.125, fundingPaid: 0.375 }), { SOLUSDT: 127.5 })
    expect(v.mark).toBe(127.5)
    expect(v.unrealized).toBeCloseTo(5, 9)
    expect(v.net).toBeCloseTo(4.5, 9)
    expect(v.r).toBeCloseTo(0.9, 9)
    expect(v.pctOfMargin).toBeCloseTo(0.09, 9)
  })

  it('un short gana cuando el precio baja', () => {
    expect(valuePosition(position('p1', { side: 'short', feesPaid: 0 }), { SOLUSDT: 120 }).unrealized).toBeCloseTo(10, 9)
  })

  it('sin marca, todo null', () => {
    expect(valuePosition(position('p1'), {})).toEqual({ mark: null, unrealized: null, net: null, r: null, pctOfMargin: null })
  })
})

describe('deriveAccount', () => {
  it('equity y capital operable con las mismas reglas que el bot', () => {
    const account = deriveAccount(
      { capitalInicial: 1000, saldo: 1247.8, protegido: 0, baseBlindaje: 1000 },
      DEFAULT_SETTINGS.capital,
      OPEN,
      MARKS,
    )
    expect(account.equity).toBeCloseTo(1195.7, 9)
    expect(account.capitalBase).toBeCloseTo(1247.8, 9)
    expect(account.margenEnUso).toBe(100)
    expect(account.capitalOperable).toBeCloseTo(1147.8, 9)
  })
})

describe('deriveCapitalCard', () => {
  const SHIELDED_AT = Date.UTC(2026, 9, 20, 15, 0)
  const live = (patch: Partial<CapitalCardLive> = {}): CapitalCardLive => ({
    settings: DEFAULT_SETTINGS,
    botStatus: null,
    market: null,
    open: [],
    ledger: { capitalInicial: 1000, saldo: 1247.8, protegido: 1000, baseBlindaje: 1000 },
    ...patch,
  })

  it('blindado: la tarjeta de core con la cuenta en vivo y la fecha del blindaje', () => {
    expect(deriveCapitalCard(live(), SHIELDED_AT)).toMatchObject({
      title: 'Blindaste los US$ 1.000 iniciales el 20 de octubre.',
      detail: 'El bot opera con US$ 248.',
      progress: 1,
      atRisk: null,
    })
  })

  it('blindado y pausado solo: el tercer estado', () => {
    const pause = { paused: true, by: 'auto' as const, at: '2026-10-31T16:10:00Z', reason: 'Me pausé solo.' }
    expect(deriveCapitalCard(live({ settings: { ...DEFAULT_SETTINGS, pause } }), SHIELDED_AT)?.title).toBe(
      'El bot se pausó: los US$ 1.000 están blindados y no queda ganancia para operar.',
    )
  })

  it('antes del blindaje: lo que falta, con las abiertas a la marca', () => {
    const card = deriveCapitalCard(
      live({ ledger: { capitalInicial: 1000, saldo: 1247.8, protegido: 0, baseBlindaje: 1000 }, open: OPEN, market: marketOf(MARKS) }),
      null,
    )
    // Meta 700 (70 % de 1.000); ganancia = min(saldo, equity) − base = 1.195,70 − 1.000.
    expect(card?.title).toBe('A US$ 505 de blindar los US$ 1.000 iniciales')
    expect(card?.progress).toBeCloseTo(195.7 / 700, 9)
  })

  it('sin ajustes no hay tarjeta', () => {
    expect(deriveCapitalCard(live({ settings: null }), null)).toBeNull()
  })
})

function marketOf(marks: Record<string, number>): CapitalCardLive['market'] {
  return {
    version: 1,
    updatedAt: NOW,
    symbols: Object.entries(marks).map(([symbol, markPrice]) => ({ symbol, markPrice, change24h: 0, sPrime: null, lean: 0, state: 'ready' as const })),
  }
}
