import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PosicionesScreen } from '@/components/posiciones/posiciones-screen'
import { OFFLINE_REASON } from '@/components/posiciones/close-position'
import { PosicionesFirstRun } from '@/components/posiciones/first-run'
import type { LivePayload } from '@/lib/live/types'
import { contextFor, livePayload, liveSession, NOW, replaySession } from '../nav/fixtures'
import { closedView, command, HOUR, liveState, screenData, solOpen, withToasts } from './helpers'

vi.mock('@/lib/db', () => ({ db: {}, repos: {} }))

const actions = vi.hoisted(() => ({ enqueueCommand: vi.fn(), cancelCommand: vi.fn() }))
vi.mock('@/lib/actions/commands', () => actions)

const live = vi.hoisted(() => ({ current: null as unknown as import('@/lib/live/provider').LiveState }))
vi.mock('@/lib/live/provider', () => ({ useLiveContext: () => live.current }))

const nav = vi.hoisted(() => ({
  search: '',
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() },
}))
vi.mock('next/navigation', () => ({
  usePathname: () => '/posiciones',
  useRouter: () => nav.router,
  useSearchParams: () => new URLSearchParams(nav.search),
}))

vi.mock('@/components/charts/lazy-candle-chart', async () => {
  const { createElement } = await import('react')
  return { LazyCandleChart: ({ label }: { label: string }) => createElement('div', { role: 'img', 'aria-label': label }) }
})

// 15:31 en Buenos Aires: la hora del último snapshot cuando el bot está sin conexión.
const SNAPSHOT_AT = NOW - 60_000

function market(at = NOW) {
  return { version: 1, updatedAt: at, symbols: [] }
}

function renderScreen(data: LivePayload, { closed = [] as ReturnType<typeof closedView>[], replay = false, query = {} } = {}) {
  live.current = liveState(data)
  const session = replay ? replaySession() : liveSession()
  const props = { data: screenData(closed, { session, closed: { ...screenData(closed).closed, query } }), context: contextFor(session) }
  const view = render(withToasts(<PosicionesScreen {...props} />))
  // Lo que trae la consulta en vivo siguiente (el comando que avanza, la abierta que se cerró).
  const rerenderWith = (next: LivePayload) => {
    live.current = liveState(next)
    view.rerender(withToasts(<PosicionesScreen {...props} />))
  }
  return { ...view, rerenderWith }
}

const cards = () => within(screen.getByRole('list', { name: 'Posiciones abiertas' }))
const table = () => within(screen.getByRole('table', { name: 'Posiciones abiertas' }))

/** "Cerrar ahora" en la tabla y la confirmación. */
async function confirmClose() {
  fireEvent.click(table().getByRole('button', { name: 'Cerrar ahora' }))
  await confirmDialog()
}

async function confirmDialog() {
  await act(async () => {
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Cerrar SOL ahora' })).getByRole('button', { name: 'Cerrar ahora' }))
  })
}

/** Los ids que llevó cada pedido de cierre, en orden. */
const sentIds = () => actions.enqueueCommand.mock.calls.map(([input]) => (input as { id: string }).id)

// La cola responde con el id que recibió, como `enqueueCommand`.
const echoEnqueue = async ({ id }: { id: string }) => ({ ok: true, id, duplicate: false })

beforeEach(() => {
  nav.search = ''
  vi.clearAllMocks()
  actions.enqueueCommand.mockResolvedValue({ ok: true, id: 'cmd-1' })
  actions.cancelCommand.mockResolvedValue({ ok: true })
})

describe('abiertas', () => {
  it('la tarjeta de celu muestra las tres líneas del spec para SOL', () => {
    renderScreen(livePayload({ open: [solOpen()], market: market() }))
    const link = cards().getByRole('link', { name: /^SOL/ })
    expect(link).toHaveTextContent('SOL · Long 5x · +US$ 12,40 (+4,1%)')
    expect(link).toHaveAttribute('href', '/posiciones?trade=pos-sol')
    expect(cards().getByText('entró a 142,10 · ahora 148,30 · 3 h')).toBeInTheDocument()
    expect(cards().getByRole('img', { name: /stop 139,3.*take profit 150/i })).toBeInTheDocument()
  })

  it('el titular dice cuántas hay abiertas y cuánto van, con el número adentro', () => {
    renderScreen(livePayload({ open: [solOpen()], market: market() }))
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('1 abierta, va ganando US$ 12,40.')
  })

  it('"Cerrar ahora" abre la confirmación con lo que vale ahora', () => {
    renderScreen(livePayload({ open: [solOpen()], market: market() }))
    fireEvent.click(table().getByRole('button', { name: 'Cerrar ahora' }))
    const dialog = screen.getByRole('dialog', { name: 'Cerrar SOL ahora' })
    expect(dialog).toHaveTextContent('Vas a cerrar SOL por +US$ 12,40')
    expect(actions.enqueueCommand).not.toHaveBeenCalled()
  })

  it('al confirmar encola `close_position` para esa moneda y muestra que se envió', async () => {
    renderScreen(livePayload({ open: [solOpen()], market: market() }))
    fireEvent.click(table().getByRole('button', { name: 'Cerrar ahora' }))
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog', { name: 'Cerrar SOL ahora' })).getByRole('button', { name: 'Cerrar ahora' }))
    })
    expect(actions.enqueueCommand).toHaveBeenCalledWith({
      id: expect.any(String),
      sessionId: 'ses_live',
      kind: 'close_position',
      payload: { symbol: 'SOLUSDT' },
    })
    expect(cards().getByText('Enviado al bot…')).toBeInTheDocument()
    // Mientras espera, el botón de la tabla se apaga: no se pide dos veces.
    expect(table().getByRole('button', { name: 'Cerrar ahora' })).toBeDisabled()
  })

  it('sigue el comando: el bot lo toma, vence sin respuesta, o se cancela mientras espera', async () => {
    const { rerenderWith } = renderScreen(livePayload({ open: [solOpen()], market: market() }))
    fireEvent.click(table().getByRole('button', { name: 'Cerrar ahora' }))
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cerrar ahora' }))
    })

    rerenderWith(livePayload({ open: [solOpen()], market: market(), commands: [command()] }))
    await act(async () => {
      fireEvent.click(cards().getByRole('button', { name: 'Cancelar' }))
    })
    expect(actions.cancelCommand).toHaveBeenCalledWith('cmd-1')
    expect(await screen.findByText('Cancelé el cierre de SOL.')).toBeInTheDocument()
    expect(cards().queryByText('Enviado al bot…')).not.toBeInTheDocument()

    rerenderWith(livePayload({ open: [solOpen()], market: market(), commands: [command({ id: 'cmd-2', status: 'claimed', claimedAt: NOW })] }))
    expect(cards().getByText('El bot está cerrando SOL…')).toBeInTheDocument()
  })

  it('si el bot no respondió en 60 s lo dice y deja reintentar', async () => {
    actions.enqueueCommand.mockResolvedValue({ ok: true, id: 'cmd-3' })
    const { rerenderWith } = renderScreen(livePayload({ open: [solOpen()], market: market() }))
    fireEvent.click(table().getByRole('button', { name: 'Cerrar ahora' }))
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cerrar ahora' }))
    })
    rerenderWith(livePayload({ open: [solOpen()], market: market(), commands: [command({ id: 'cmd-3', expired: true })] }))
    expect(cards().getByText('El bot no respondió. No cerré SOL.')).toBeInTheDocument()
    fireEvent.click(cards().getByRole('button', { name: 'Reintentar' }))
    expect(screen.getByRole('dialog', { name: 'Cerrar SOL ahora' })).toBeInTheDocument()
  })

  it('cuando el bot la cerró avisa con su mensaje', async () => {
    const { rerenderWith } = renderScreen(livePayload({ open: [solOpen()], market: market() }))
    fireEvent.click(table().getByRole('button', { name: 'Cerrar ahora' }))
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cerrar ahora' }))
    })
    rerenderWith(
      livePayload({ open: [], market: market(), commands: [command({ status: 'done', finishedAt: NOW, result: { ok: true, message: 'Cerré SOL.' } })] }),
    )
    expect(await screen.findByText('Cerré SOL.')).toBeInTheDocument()
    // La abierta desapareció: el historial del servidor se pide de nuevo.
    expect(nav.router.refresh).toHaveBeenCalled()
  })

  it('si el pedido no llega, la confirmación no queda trabada: se cierra, lo dice y el reintento lleva el mismo id', async () => {
    actions.enqueueCommand.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    renderScreen(livePayload({ open: [solOpen()], market: market() }))

    await confirmClose()
    expect(await screen.findByText('No pude mandar el pedido de cerrar SOL. Revisá la conexión y probá de nuevo.')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Cerrar SOL ahora' })).not.toBeInTheDocument())
    expect(cards().queryByText('Enviado al bot…')).not.toBeInTheDocument()
    expect(table().getByRole('button', { name: 'Cerrar ahora' })).toBeEnabled()

    // No se sabe si llegó: el reintento repite el id y la cola no lo duplica.
    await confirmClose()
    const ids = sentIds()
    expect(ids).toHaveLength(2)
    expect(ids[1]).toBe(ids[0])
    expect(cards().getByText('Enviado al bot…')).toBeInTheDocument()
  })

  it('con un cierre de SOL ya en la cola (otra pestaña), confirmar lo sigue en vez de encolar otro', async () => {
    actions.enqueueCommand.mockImplementation(echoEnqueue)
    const { rerenderWith } = renderScreen(livePayload({ open: [solOpen()], market: market() }))
    fireEvent.click(table().getByRole('button', { name: 'Cerrar ahora' }))
    // Llega mientras la confirmación está abierta.
    rerenderWith(livePayload({ open: [solOpen()], market: market(), commands: [command({ id: 'cmd-otra' })] }))
    await confirmDialog()
    expect(sentIds()).toEqual(['cmd-otra'])
    expect(cards().getByText('Enviado al bot…')).toBeInTheDocument()
  })

  it('si la cancelación no llega, lo dice y el pedido sigue a la vista con "Cancelar"', async () => {
    actions.cancelCommand.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const { rerenderWith } = renderScreen(livePayload({ open: [solOpen()], market: market() }))
    fireEvent.click(table().getByRole('button', { name: 'Cerrar ahora' }))
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cerrar ahora' }))
    })
    rerenderWith(livePayload({ open: [solOpen()], market: market(), commands: [command()] }))
    await act(async () => {
      fireEvent.click(cards().getByRole('button', { name: 'Cancelar' }))
    })
    expect(await screen.findByText('No pude cancelar el cierre de SOL. Revisá la conexión y probá de nuevo.')).toBeInTheDocument()
    expect(cards().getByText('Enviado al bot…')).toBeInTheDocument()
    expect(cards().getByRole('button', { name: 'Cancelar' })).toBeInTheDocument()
  })

  it('en la tabla cada fila tiene una celda por columna; el estado del cierre va en una fila propia', async () => {
    renderScreen(livePayload({ open: [solOpen()], market: market() }))
    const columns = table().getAllByRole('columnheader').length
    const bodyRows = () => table().getAllByRole('row').slice(1)
    expect(bodyRows()).toHaveLength(1)
    fireEvent.click(table().getByRole('button', { name: 'Cerrar ahora' }))
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cerrar ahora' }))
    })
    const [row, statusRow] = bodyRows()
    expect(within(row!).getAllByRole('cell')).toHaveLength(columns)
    const status = within(statusRow!).getByRole('cell')
    expect(status).toHaveAttribute('aria-colspan', String(columns))
    expect(status).toHaveTextContent('Enviado al bot…')
  })

  it('en la tabla de desktop la unidad va en el encabezado y cada fila muestra sólo el número', () => {
    renderScreen(livePayload({ open: [solOpen()], market: market() }))
    expect(table().getByRole('columnheader', { name: 'Moneda y resultado en US$' })).toBeInTheDocument()
    // "US$" queda para lectores de pantalla; la tarjeta del celu (sin encabezado) lo muestra.
    expect(within(table().getByRole('link', { name: /^SOL/ })).getByText('US$')).toHaveClass('desktop:sr-only')
    expect(within(cards().getByRole('link', { name: /^SOL/ })).getByText('US$')).not.toHaveClass('desktop:sr-only')
  })

  it('sin conexión: precios apagados con la hora del snapshot y "Cerrar ahora" deshabilitado con la razón', () => {
    renderScreen(livePayload({ open: [solOpen()], market: market(SNAPSHOT_AT), offline: true }))
    expect(cards().getByText('entró a 142,10 · 148,30 a las 15:31 · 3 h')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('1 abierta, a las 15:31 iba ganando US$ 12,40.')
    expect(table().getByRole('button', { name: 'Cerrar ahora' })).toBeDisabled()
    expect(cards().getByRole('button', { name: 'Cerrar ahora' })).toBeDisabled()
    expect(screen.getByText(OFFLINE_REASON)).toBeInTheDocument()
  })

  it('en un replay: en pasado, con el precio del final y sin acciones sobre el bot', () => {
    renderScreen(livePayload({ sessionId: 'ses_replay', open: [solOpen()], market: market() }), { replay: true })
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Terminó con 1 abierta, que iba ganando US$ 12,40.')
    expect(cards().getByText(/al final 148,30/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cerrar ahora' })).not.toBeInTheDocument()
    expect(screen.queryByText(OFFLINE_REASON)).not.toBeInTheDocument()
  })
})

// La acción falla en el camino de vuelta pero el comando quedó en la cola: aparece en la consulta en vivo.
describe('un pedido sin respuesta que sí llegó', () => {
  async function lostResponse() {
    actions.enqueueCommand.mockImplementation(echoEnqueue).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const view = renderScreen(livePayload({ open: [solOpen()], market: market() }))
    await confirmClose()
    await screen.findByText('No pude mandar el pedido de cerrar SOL. Revisá la conexión y probá de nuevo.')
    const sent = sentIds()[0]!
    const arrived = (patch: Parameters<typeof command>[0] = {}, open = [solOpen()]) =>
      view.rerenderWith(livePayload({ open, market: market(), commands: [command({ id: sent, ...patch })] }))
    return { sent, arrived }
  }

  it('cancelado mientras espera, el próximo "Cerrar ahora" manda un pedido nuevo y se ve', async () => {
    const { sent, arrived } = await lostResponse()
    arrived()
    await act(async () => {
      fireEvent.click(cards().getByRole('button', { name: 'Cancelar' }))
    })
    expect(actions.cancelCommand).toHaveBeenCalledWith(sent)
    expect(await screen.findByText('Cancelé el cierre de SOL.')).toBeInTheDocument()
    arrived({ status: 'cancelled', finishedAt: NOW })

    await confirmClose()
    const [, retry] = sentIds()
    expect(retry).toBeDefined()
    expect(retry).not.toBe(sent)
    expect(cards().getByText('Enviado al bot…')).toBeInTheDocument()
  })

  it('si venció, lo dice como cualquier pedido de acá y "Reintentar" manda uno nuevo', async () => {
    const { sent, arrived } = await lostResponse()
    arrived({ status: 'expired', expired: true, finishedAt: NOW })
    expect(cards().getByText('El bot no respondió. No cerré SOL.')).toBeInTheDocument()

    fireEvent.click(cards().getByRole('button', { name: 'Reintentar' }))
    await confirmDialog()
    const [, retry] = sentIds()
    expect(retry).toBeDefined()
    expect(retry).not.toBe(sent)
    expect(cards().getByText('Enviado al bot…')).toBeInTheDocument()
  })

  it('si el bot la cerró, avisa con su mensaje', async () => {
    const { arrived } = await lostResponse()
    arrived({ status: 'done', finishedAt: NOW, result: { ok: true, message: 'Cerré SOL.' } }, [])
    expect(await screen.findByText('Cerré SOL.')).toBeInTheDocument()
  })

  it('si llega con la confirmación abierta, confirmar repite su id: la cola no encola un segundo cierre', async () => {
    const { sent, arrived } = await lostResponse()
    fireEvent.click(table().getByRole('button', { name: 'Cerrar ahora' }))
    arrived()
    await confirmDialog()
    expect(sentIds()).toEqual([sent, sent])
    expect(cards().getByText('Enviado al bot…')).toBeInTheDocument()
  })
})

describe('cerradas', () => {
  const won = closedView('c-won', { closedAt: NOW - 2 * HOUR, pnlNet: 9.5 })
  const liquidated = closedView('c-liq', { symbol: 'DOGEUSDT', closedAt: NOW - 1 * HOUR, closeReason: 'liquidation', pnlNet: -50, rMultiple: -10 })

  it('agrupa por día y destaca la liquidación con su etiqueta, no sólo con color', () => {
    nav.search = 'vista=cerradas'
    renderScreen(livePayload({ market: market() }), { closed: [liquidated, won] })
    const today = screen.getByRole('region', { name: 'Hoy' })
    expect(within(today).getByRole('link', { name: /^DOGE/ })).toHaveTextContent('DOGE · Long 5x · −US$ 50,00 (−100,0%)')
    expect(within(today).getByText('Liquidada')).toHaveClass('text-loss', 'font-semibold')
  })

  it('en desktop el historial lleva la unidad en el encabezado, no en cada fila', () => {
    nav.search = 'vista=cerradas'
    renderScreen(livePayload({ market: market() }), { closed: [liquidated, won] })
    expect(screen.getByText('Moneda y resultado en US$')).toBeInTheDocument()
    const row = within(screen.getByRole('region', { name: 'Hoy' })).getByRole('link', { name: /^DOGE/ })
    expect(within(row).getByText('US$')).toHaveClass('desktop:sr-only')
  })

  it('el filtro "Liquidadas" va a la URL con la vista de cerradas y desde la primera página', () => {
    nav.search = 'vista=cerradas&pagina=2'
    renderScreen(livePayload({ market: market() }), { closed: [liquidated, won] })
    const toggle = screen.getByRole('button', { name: 'Liquidadas' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(toggle)
    const [href] = nav.router.replace.mock.calls[0] as [string]
    const url = new URL(href, 'http://localhost')
    expect(url.pathname).toBe('/posiciones')
    expect(Object.fromEntries(url.searchParams)).toEqual({ vista: 'cerradas', liquidadas: '1' })
  })

  it('con filtros y nada que mostrar, lo dice y deja quitarlos', () => {
    nav.search = 'vista=cerradas&liquidadas=1'
    renderScreen(livePayload({ market: market() }), { query: { liquidadas: '1' } })
    expect(screen.getByText('Ninguna operación cerrada con estos filtros.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Quitar filtros' })).toHaveAttribute('href', '/posiciones?vista=cerradas')
  })

  it('sin ninguna cerrada todavía, el vacío del spec', () => {
    nav.search = 'vista=cerradas'
    renderScreen(livePayload({ market: market() }))
    expect(screen.getByText('Acá van a aparecer las operaciones cerradas')).toBeInTheDocument()
  })
})

describe('hoja de un trade', () => {
  it('`?trade=<id>` la abre con la cabecera de la fila y "Cerrar ahora" abajo', () => {
    nav.search = 'trade=pos-sol'
    renderScreen(livePayload({ open: [solOpen()], market: market() }))
    const sheet = screen.getByRole('dialog')
    expect(within(sheet).getByRole('heading', { level: 2 })).toHaveTextContent('SOL · Long 5x · +US$ 12,40 (+4,1%)')
    expect(within(sheet).getByText('Abierta desde hoy a las 12:32')).toBeInTheDocument()
    fireEvent.click(within(sheet).getByRole('button', { name: 'Cerrar ahora' }))
    expect(screen.getByRole('dialog', { name: 'Cerrar SOL ahora' })).toBeInTheDocument()
  })

  it('cerrarla sin haberla abierto desde acá saca `trade` de la URL sin sumar historial', () => {
    nav.search = 'vista=abiertas&trade=pos-sol'
    renderScreen(livePayload({ open: [solOpen()], market: market() }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(nav.router.replace).toHaveBeenCalledWith('/posiciones?vista=abiertas', { scroll: false })
    expect(nav.router.back).not.toHaveBeenCalled()
  })
})

describe('estadísticas', () => {
  it('la tarjeta de veredicto dice cuánto falta: "faltan 77" con 23 trades', () => {
    nav.search = 'vista=estadisticas'
    const closed = Array.from({ length: 23 }, (_, i) => closedView(`c-${i}`, { closedAt: NOW - (i + 1) * HOUR }))
    renderScreen(livePayload({ market: market() }), { closed })
    expect(screen.getByRole('region', { name: 'Todavía no se puede saber.' })).toHaveTextContent('23 de 100 · faltan 77')
  })
})

describe('primer uso', () => {
  it('sin simulación, el vacío del spec con el camino al resumen', () => {
    render(<PosicionesFirstRun />)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Acá van a aparecer las operaciones cerradas')
    expect(screen.getByRole('link', { name: 'Ir al resumen' })).toHaveAttribute('href', '/')
  })
})
