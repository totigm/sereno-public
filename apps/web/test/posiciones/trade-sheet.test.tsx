import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ClosePositionProvider } from '@/components/posiciones/close-position'
import { TradeSheet } from '@/components/posiciones/trade-sheet'
import type { TradeScope } from '@/components/posiciones/trade-model'
import type { LivePayload } from '@/lib/live/types'
import type { Candle } from '@sereno/core'
import type { PositionEventView, TradeDetail } from '@/lib/queries/posiciones'
import { livePayload, NOW } from '../nav/fixtures'
import { activeScope, closedView, HOUR, liveState, openView, replayScope, solOpen, withToasts } from './helpers'

vi.mock('@/lib/db', () => ({ db: {}, repos: {} }))
vi.mock('@/lib/actions/commands', () => ({ enqueueCommand: vi.fn(), cancelCommand: vi.fn() }))

const live = vi.hoisted(() => ({ current: null as unknown as import('@/lib/live/provider').LiveState }))
vi.mock('@/lib/live/provider', () => ({ useLiveContext: () => live.current }))

// El gráfico guarda lo que recibe: las líneas y marcas que arma la hoja.
const chart = vi.hoisted(() => ({ props: null as null | import('@/components/charts/candle-chart').CandleChartProps }))
vi.mock('@/components/charts/lazy-candle-chart', async () => {
  const { createElement } = await import('react')
  return {
    LazyCandleChart: (props: import('@/components/charts/candle-chart').CandleChartProps) => {
      chart.props = props
      return createElement('div', { role: 'img', 'aria-label': props.label })
    },
  }
})

const OPENED = NOW - 12 * HOUR
const CLOSED = NOW - HOUR

const btc = closedView('c-btc', {
  symbol: 'BTCUSDT',
  side: 'short',
  leverage: 2,
  margin: 183.66,
  entryPrice: 73463.85,
  exitPrice: 71640.5,
  stopPrice: 72648,
  takeProfitPrice: 71604.7,
  liquidationPrice: 109728.4,
  riesgoReal: 4.7,
  openedAt: OPENED,
  closedAt: CLOSED,
  pnlNet: 8.81,
  rMultiple: 1.87,
  openReason: 'Abrí un short 2x en BTC con US$ 183,66. El precio está cerca de la banda superior.',
  costs: { fees: 0.36, spread: 0.07, slippage: 0.22, funding: -0.05 },
})

let nextId = 1
const event = (kind: PositionEventView['kind'], at: number, payload: Record<string, unknown>): PositionEventView => ({ id: nextId++, kind, payload, at })

const M15 = 15 * 60_000

/** Velas de 15 m desde `from` (inclusive) hasta `to` (exclusive). */
function candlesBetween(from: number, to: number): Candle[] {
  const out: Candle[] = []
  for (let at = from; at < to; at += M15) {
    out.push({ openTime: at, closeTime: at + M15 - 1, open: 1.5, high: 1.6, low: 1.4, close: 1.55, volume: 1, quoteVolume: 1.5, closed: true })
  }
  return out
}

function detailOf(position: TradeDetail['position'], events: PositionEventView[], closed = true, candles: Candle[] = []): TradeDetail {
  return {
    position,
    closed,
    events,
    candles,
    signals: [
      { id: 'trend15m', value: -0.55, weight: 1.5 },
      { id: 'momentum', value: 0.2, weight: 0.8 },
      { id: 'funding', value: null, weight: 1 },
    ],
  }
}

const btcEvents = () => [
  event('open', OPENED, { price: 73463.85, qty: 0.005, fee: 0.18, spreadCost: 0.04, slippageCost: 0.11 }),
  event('order_placed', OPENED, { orderId: 'o-1', type: 'STOP_MARKET', stopPrice: 74426.5 }),
  event('funding', OPENED + 6 * HOUR, { amount: -0.05 }),
  event('stop_moved', OPENED + 7 * HOUR, { from: 74426.5, to: 73438.1, phrase: 'Bajé el stop del short en BTC de 74.426,50 a 73.438,10.' }),
  event('stop_moved', OPENED + 9 * HOUR, { from: 73438.1, to: 72648 }),
  event('close', CLOSED, { price: 71640.5, qty: 0.005, fee: 0.18, reason: 'take_profit', pnlNet: 8.81, phrase: 'Cerré el short en BTC en el take profit: +US$ 8,81 (+1,9R).' }),
]

function renderSheet(props: { tradeId: string; known: TradeDetail['position'] | null; detail: TradeDetail | null; scope: TradeScope }, data: LivePayload = livePayload()) {
  live.current = liveState(data)
  return render(
    withToasts(
      <ClosePositionProvider enabled={props.scope.active} offline={props.scope.offline}>
        <TradeSheet {...props} onClose={() => {}} />
      </ClosePositionProvider>,
    ),
  )
}

beforeEach(() => {
  nextId = 1
  chart.props = null
})

describe('hoja de una cerrada', () => {
  it('la cabecera es el bloque de la fila y debajo dice por qué y cuándo cerró', () => {
    renderSheet({ tradeId: 'c-btc', known: btc, detail: detailOf(btc, btcEvents()), scope: activeScope() })
    const sheet = screen.getByRole('dialog')
    expect(within(sheet).getByRole('heading', { level: 2 })).toHaveTextContent('BTC · Short 2x · +US$ 8,81 (+4,8%)')
    expect(within(sheet).getByText('Take profit · cerró hoy a las 14:32')).toBeInTheDocument()
    expect(within(sheet).queryByRole('button', { name: 'Cerrar ahora' })).not.toBeInTheDocument()
  })

  it('la cabecera ocupa todo el ancho: el resultado queda a la derecha, como en la fila', () => {
    renderSheet({ tradeId: 'c-btc', known: btc, detail: detailOf(btc, btcEvents()), scope: activeScope() })
    expect(within(screen.getByRole('dialog')).getByRole('heading', { level: 2 })).toHaveClass('min-w-0', 'flex-1')
  })

  it('las velas van con la entrada, el stop (y dónde arrancó), el take profit y la salida', () => {
    renderSheet({ tradeId: 'c-btc', known: btc, detail: detailOf(btc, btcEvents()), scope: activeScope() })
    expect(screen.getByRole('img', { name: 'Velas de 15 minutos con la entrada, el stop, el take profit y la salida del trade.' })).toBeInTheDocument()
    const legend = (label: string) => screen.getByText(label, { selector: 'dt' }).parentElement
    expect(legend('Entrada')).toHaveTextContent('73.463,85')
    expect(legend('Stop')).toHaveTextContent('72.648,00arrancó en 74.426,50')
    expect(legend('Take profit')).toHaveTextContent('71.604,70')
    expect(legend('Salida')).toHaveTextContent('71.640,50')
  })

  it('el motivo y las señales con su valor (a favor o en contra del lado) y su peso', () => {
    renderSheet({ tradeId: 'c-btc', known: btc, detail: detailOf(btc, btcEvents()), scope: activeScope() })
    expect(screen.getByText(/El precio está cerca de la banda superior/)).toBeInTheDocument()
    expect(screen.getByRole('listitem', { name: 'Tendencia de 15 minutos: −0,55, a favor, peso 1,50' })).toBeInTheDocument()
    expect(screen.getByRole('listitem', { name: 'Momentum: +0,20, en contra, peso 0,80' })).toBeInTheDocument()
    expect(screen.getByRole('listitem', { name: 'Funding: sin dato, peso 1,00' })).toBeInTheDocument()
  })

  it('la línea de tiempo cuenta la historia en la voz del diario, sin las órdenes del exchange', () => {
    renderSheet({ tradeId: 'c-btc', known: btc, detail: detailOf(btc, btcEvents()), scope: activeScope() })
    const timeline = screen.getByRole('heading', { name: 'Qué pasó' }).parentElement!
    const items = within(timeline).getAllByRole('listitem').map((li) => li.textContent)
    // "US$" y el número van pegados (espacio duro): no se separan al final de una línea.
    expect(items).toEqual([
      '03:32Abrí a 73.463,85.',
      '09:32Cobré US$\u00a00,05 de funding.',
      '10:32Bajé el stop del short en BTC de 74.426,50 a 73.438,10.',
      '12:32Moví el stop de 73.438,10 a 72.648,00.',
      '14:32Cerré el short en BTC en el take profit: +US$\u00a08,81 (+1,9R).',
    ])
  })

  it('los costos con el funding cobrado restando y lo que se llevaron del riesgo', () => {
    renderSheet({ tradeId: 'c-btc', known: btc, detail: detailOf(btc, btcEvents()), scope: activeScope() })
    const row = (label: string) => screen.getByText(label, { selector: 'dt' }).parentElement
    expect(row('Funding cobrado')).toHaveTextContent('US$ 0,05')
    expect(row('Total')).toHaveTextContent('US$ 0,60')
    expect(screen.getByText('Los costos se llevaron 0,13R del riesgo de US$ 4,70.')).toBeInTheDocument()
  })
})

describe('hoja de una abierta', () => {
  it('con la sesión activa: precio vivo, "Cerrar ahora" abajo y esqueletos mientras llega el detalle', () => {
    const sol = solOpen()
    renderSheet({ tradeId: 'pos-sol', known: sol, detail: null, scope: activeScope() }, livePayload({ open: [sol] }))
    const sheet = screen.getByRole('dialog')
    expect(within(sheet).getByText('Abierta desde hoy a las 12:32')).toBeInTheDocument()
    expect(within(sheet).getByRole('button', { name: 'Cerrar ahora' })).toBeEnabled()
    expect(within(sheet).getByText('Abierta hace').nextElementSibling).toHaveTextContent('3 h')
    expect(within(sheet).getByText('Total hasta ahora', { selector: 'dt' })).toBeInTheDocument()
  })

  it('el funding positivo es pagado (contrato con el bot)', () => {
    const sol = solOpen()
    const events = [event('open', sol.openedAt, { price: 142.1, qty: 2, fee: 0.14, spreadCost: 0.03, slippageCost: 0.02 }), event('funding', sol.openedAt + HOUR, { amount: 0.12 })]
    renderSheet({ tradeId: 'pos-sol', known: sol, detail: detailOf(sol, events, false), scope: activeScope() }, livePayload({ open: [sol] }))
    expect(screen.getByText('Pagué US$ 0,12 de funding.')).toBeInTheDocument()
  })

  it('con la sesión activa los niveles llegan hasta la última vela y no hay marca de final', () => {
    const sol = solOpen()
    const candles = candlesBetween(sol.openedAt - 4 * HOUR, NOW)
    renderSheet({ tradeId: 'pos-sol', known: sol, detail: detailOf(sol, [], false, candles), scope: activeScope() }, livePayload({ open: [sol] }))
    const last = candles.at(-1)!.closeTime
    for (const line of chart.props?.lines ?? []) expect(Math.max(...line.points.map((p) => p.at))).toBe(last)
    expect(chart.props?.markers).toEqual([expect.objectContaining({ at: sol.openedAt, shape: 'arrowUp' })])
    expect(screen.getByText('Precio', { selector: 'dt' }).parentElement).toHaveTextContent('148,30')
  })

  it('en un replay los niveles terminan donde terminó la sesión, aunque haya velas de después', () => {
    const scope = replayScope()
    const end = scope.now
    const sui = openView('pos-sui', { symbol: 'SUIUSDT', side: 'long', entryPrice: 1.5, stopPrice: 1.45, takeProfitPrice: 1.6, openedAt: end - 3 * HOUR }, { mark: 1.55 })
    const candles = candlesBetween(end - 7 * HOUR, end + 4 * HOUR)
    renderSheet({ tradeId: 'pos-sui', known: sui, detail: detailOf(sui, [], false, candles), scope }, livePayload({ sessionId: 'ses_replay', open: [sui] }))
    const lines = chart.props?.lines ?? []
    expect(lines.map((l) => l.id)).toEqual(['entry', 'stop', 'tp'])
    for (const line of lines) expect(Math.max(...line.points.map((p) => p.at))).toBe(end)
    // La marca del final, con el precio de ese momento en la leyenda.
    expect(chart.props?.markers).toEqual([
      expect.objectContaining({ at: sui.openedAt, shape: 'arrowUp' }),
      expect.objectContaining({ at: end, tone: 'ink', shape: 'circle' }),
    ])
    expect(screen.getByText('Al final', { selector: 'dt' }).parentElement).toHaveTextContent('1,55')
  })

  it('en un replay va en pasado, con fechas completas y sin acciones', () => {
    const sol = solOpen()
    renderSheet({ tradeId: 'pos-sol', known: sol, detail: null, scope: replayScope() }, livePayload({ sessionId: 'ses_replay', open: [sol] }))
    const sheet = screen.getByRole('dialog')
    expect(within(sheet).getByText('Seguía abierta al final · abrió el 31 de octubre a las 12:32')).toBeInTheDocument()
    expect(within(sheet).getByText('Abierta durante')).toBeInTheDocument()
    expect(within(sheet).queryByRole('button', { name: 'Cerrar ahora' })).not.toBeInTheDocument()
  })
})
