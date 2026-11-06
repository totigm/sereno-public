import { describe, expect, it, vi } from 'vitest'
import { closeSentence } from '@/components/posiciones/close-position'
import { closeStatusText, isClosing } from '@/components/posiciones/close-status'
import { dayLabel, durationLabel, formatResult, momentLabel, resultParts, whenLabel } from '@/components/posiciones/format'
import { priceNowText } from '@/components/posiciones/open-card'
import { closedLine, headlinePhrase } from '@/components/posiciones/posiciones-headline'
import { costsOf, costTotal } from '@/components/posiciones/trade-costs'
import { stopPath } from '@/components/posiciones/trade-chart'
import { summarize, tradeScope } from '@/components/posiciones/trade-model'
import { signalLabel } from '@/components/posiciones/trade-signals'
import { timelineEntries } from '@/components/posiciones/trade-timeline'
import type { PositionEventView } from '@/lib/queries/posiciones'
import { formatUsd, MINUS } from '@/lib/format'
import { statsView } from '@/lib/queries/stats'
import { contextFor, livePayload, liveSession, NOW, replaySession } from '../nav/fixtures'
import { activeScope, closedView, HOUR, openView, replayScope, solOpen } from './helpers'

vi.mock('@/lib/db', () => ({ db: {}, repos: {} }))
vi.mock('@/lib/actions/commands', () => ({ enqueueCommand: vi.fn(), cancelCommand: vi.fn() }))

const MINUTE = 60_000
const phrase = (p: { before: string; amount: number | null; after: string }) => `${p.before}${p.amount === null ? '' : `[${p.amount.toFixed(2)}]`}${p.after}`
const ev = (id: number, kind: PositionEventView['kind'], payload: Record<string, unknown>, at = NOW): PositionEventView => ({ id, kind, payload, at })

describe('formatos', () => {
  it('duración truncada como la antigüedad del diario', () => {
    expect(durationLabel(30_000)).toBe('1 min')
    expect(durationLabel(28 * MINUTE)).toBe('28 min')
    expect(durationLabel(3 * HOUR + 59 * MINUTE)).toBe('3 h')
    expect(durationLabel(47 * HOUR)).toBe('47 h')
    expect(durationLabel(50 * HOUR)).toBe('2 días')
  })

  it('"hoy" y "ayer" sólo con reloj (sesión activa); si terminó, fechas completas', () => {
    const today = NOW - 2 * HOUR
    const yesterday = NOW - 20 * HOUR
    expect(dayLabel(today, NOW)).toBe('Hoy')
    expect(dayLabel(yesterday, NOW)).toBe('Ayer')
    expect(dayLabel(today, null)).toBe('31 de octubre')
    expect(momentLabel(today, NOW)).toBe('13:32')
    expect(momentLabel(yesterday, NOW)).toBe('ayer 19:32')
    expect(momentLabel(today, null)).toBe('31 de octubre 13:32')
    expect(whenLabel(today, NOW)).toBe('hoy a las 13:32')
    expect(whenLabel(yesterday, NOW)).toBe('ayer a las 19:32')
    expect(whenLabel(NOW - 3 * 24 * HOUR, NOW)).toBe('el 28 de octubre a las 15:32')
  })

  it('el resultado en partes: el signo del valor redondeado y el monto sin signo', () => {
    expect(resultParts(12.4)).toEqual({ sign: '+', magnitude: '12,40' })
    expect(resultParts(-1247.8)).toEqual({ sign: MINUS, magnitude: '1.247,80' })
    // Lo que redondea a cero no lleva signo, como "exceptZero" en el formato de montos.
    expect(resultParts(-0.004)).toEqual({ sign: '', magnitude: '0,00' })
    expect(resultParts(0)).toEqual({ sign: '', magnitude: '0,00' })
  })

  it('"+US$ 12,40" se arma con esas partes y es el mismo texto que el formato de montos con signo', () => {
    for (const n of [12.4, -12.4, 0, -0, 0.004, -0.004, 0.005, -0.005, 999.995, -1247.8, 1_250_000]) {
      const { sign, magnitude } = resultParts(n)
      expect(formatResult(n)).toBe(`${sign}US$ ${magnitude}`)
      expect(formatResult(n)).toBe(formatUsd(n, { sign: true }))
    }
  })

  it('las señales se nombran como en el diario, sin el artículo', () => {
    expect(signalLabel('trend15m')).toBe('Tendencia de 15 minutos')
    expect(signalLabel('btcRegime')).toBe('Régimen de BTC')
  })
})

describe('alcance', () => {
  it('activa: presente, con reloj y precios de recién', () => {
    expect(activeScope(livePayload({ market: { version: 1, updatedAt: NOW, symbols: [] } }))).toEqual({
      sessionId: 'ses_live',
      active: true,
      offline: false,
      pricesAt: null,
      now: NOW,
      clock: NOW,
    })
  })

  it('sin conexión: precios del último snapshot', () => {
    const scope = activeScope(livePayload({ offline: true, market: { version: 1, updatedAt: NOW - MINUTE, symbols: [] } }))
    expect(scope).toMatchObject({ offline: true, pricesAt: NOW - MINUTE })
  })

  it('un replay: sin reloj, "ahora" es su final y nunca está sin conexión', () => {
    const session = replaySession()
    const scope = tradeScope(contextFor(session), livePayload({ sessionId: 'ses_replay', offline: true }))
    expect(scope).toMatchObject({ active: false, offline: false, clock: null, now: session.period.to })
    expect(tradeScope(contextFor(liveSession()), livePayload()).active).toBe(true)
  })
})

describe('titular', () => {
  const pnl = (net: number | null) => openView('p', {}, { net })

  it('en presente, con el número adentro', () => {
    expect(phrase(headlinePhrase([solOpen()], activeScope()))).toBe('1 abierta, va ganando [12.40].')
    expect(phrase(headlinePhrase([pnl(-3), pnl(-2)], activeScope()))).toBe('2 abiertas, van perdiendo [-5.00].')
    expect(phrase(headlinePhrase([pnl(0.001)], activeScope()))).toBe('1 abierta, está en cero.')
    expect(phrase(headlinePhrase([], activeScope()))).toBe('Ninguna operación abierta ahora.')
    expect(phrase(headlinePhrase([pnl(null)], activeScope()))).toBe('1 abierta; alguna no tiene precio para valuarla.')
  })

  it('sin conexión dice de qué hora son los precios', () => {
    const offline = activeScope(livePayload({ offline: true, market: { version: 1, updatedAt: NOW - MINUTE, symbols: [] } }))
    expect(phrase(headlinePhrase([pnl(2), pnl(1)], offline))).toBe('2 abiertas, a las 15:31 iban ganando [3.00].')
  })

  it('en pasado si la sesión terminó', () => {
    expect(phrase(headlinePhrase([pnl(4)], replayScope()))).toBe('Terminó con 1 abierta, que iba ganando [4.00].')
    expect(phrase(headlinePhrase([], replayScope()))).toBe('Terminó sin operaciones abiertas.')
  })

  it('la línea de las cerradas', () => {
    const drawdown = { pct: 0, peakAt: null, troughAt: null, resolution: null }
    expect(closedLine(statsView([], drawdown))).toBe('Todavía no se cerró ninguna operación.')
    const book = [closedView('a', { pnlNet: 9.5 }), closedView('b', { pnlNet: -2, closeReason: 'stop', rMultiple: -0.4 })]
    expect(closedLine(statsView(book, drawdown))).toBe('2 cerradas, 1 ganada · cerrado +US$ 7,50')
  })
})

describe('abiertas y cierres', () => {
  it('el precio de la tarjeta según el momento', () => {
    expect(priceNowText(148.3, activeScope())).toBe('ahora 148,30')
    expect(priceNowText(148.3, activeScope(livePayload({ offline: true, market: { version: 1, updatedAt: NOW - MINUTE, symbols: [] } })))).toBe(
      '148,30 a las 15:31',
    )
    expect(priceNowText(148.3, replayScope())).toBe('al final 148,30')
    expect(priceNowText(null, activeScope())).toBe('sin precio')
  })

  it('la frase de la confirmación, con o sin precio para valuarla', () => {
    expect(closeSentence(solOpen())).toBe('Vas a cerrar SOL por +US$ 12,40')
    expect(closeSentence(openView('p', { symbol: '1000PEPEUSDT' }, { net: null }))).toBe('Vas a cerrar PEPE al precio de mercado')
  })

  it('los estados del comando en palabras; los que bloquean un nuevo pedido', () => {
    expect(closeStatusText({ kind: 'sending' }, 'SOL')).toBe('Enviado al bot…')
    expect(closeStatusText({ kind: 'claimed', commandId: 'c' }, 'SOL')).toBe('El bot está cerrando SOL…')
    expect(closeStatusText({ kind: 'expired' }, 'SOL')).toBe('El bot no respondió. No cerré SOL.')
    expect(closeStatusText({ kind: 'failed', message: 'SOL ya no estaba abierta.' }, 'SOL')).toBe('SOL ya no estaba abierta.')
    expect(isClosing({ kind: 'pending', commandId: 'c' })).toBe(true)
    expect(isClosing({ kind: 'expired' })).toBe(false)
    expect(isClosing(null)).toBe(false)
  })

  it('una cerrada resume lo realizado sobre el margen', () => {
    expect(summarize(closedView('c', { pnlNet: 9.5 }))).toMatchObject({ coin: 'SOL', closed: true, result: 9.5, pct: 0.19, price: 130 })
  })
})

describe('hoja: stop, línea de tiempo y costos', () => {
  it('el stop arranca donde estaba antes del primer movimiento', () => {
    const trade = { openedAt: NOW - 5 * HOUR, stopPrice: 125 }
    expect(stopPath(trade, [])).toEqual([{ at: NOW - 5 * HOUR, value: 125 }])
    expect(stopPath(trade, [ev(1, 'stop_moved', { from: 122.5, to: 124 }, NOW - 3 * HOUR), ev(2, 'stop_moved', { from: 124, to: 125 }, NOW - HOUR)])).toEqual([
      { at: NOW - 5 * HOUR, value: 122.5 },
      { at: NOW - 3 * HOUR, value: 124 },
      { at: NOW - HOUR, value: 125 },
    ])
  })

  it('funding con signo del contrato (positivo = pagado); cero y órdenes no se cuentan', () => {
    const entries = timelineEntries([
      ev(1, 'open', { price: 142.1 }),
      ev(2, 'order_placed', { orderId: 'x' }),
      ev(3, 'funding', { amount: 0.12 }),
      ev(4, 'funding', { amount: -0.3 }),
      ev(5, 'funding', { amount: 0 }),
      ev(6, 'stop_moved', { from: 139.3, to: 142.1 }),
      ev(7, 'liquidation', { price: 115.2, pnlNet: -50, phrase: 'Me liquidaron el long en SOL: perdí los US$ 50 de margen.' }),
    ])
    expect(entries.map((e) => [e.text, e.tone])).toEqual([
      ['Abrí a 142,10.', 'ink'],
      ['Pagué US$ 0,12 de funding.', 'muted'],
      ['Cobré US$ 0,30 de funding.', 'muted'],
      ['Moví el stop de 139,30 a 142,10.', 'ink'],
      ['Me liquidaron el long en SOL: perdí los US$ 50 de margen.', 'loss'],
    ])
  })

  it('una abierta: spread y slippage de la entrada (evento `open`); sin ellos el total no se inventa', () => {
    const sol = openView('p', { feesPaid: 0.14, fundingPaid: -0.02 })
    const open = [ev(1, 'open', { price: 125, qty: 2, fee: 0.14, spreadCost: 0.03, slippageCost: 0.05 })]
    const costs = costsOf(sol, open)
    expect(costs).toEqual({ fees: 0.14, spread: 0.03, slippage: 0.05, funding: -0.02 })
    expect(costTotal(costs)).toBeCloseTo(0.2, 9)
    expect(costTotal(costsOf(sol, null))).toBeNull()
  })
})
