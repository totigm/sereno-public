import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ResumenScreen } from '@/components/resumen/resumen-screen'
import { resumenReportView, type ResumenReportView } from '@/lib/queries/resumen-report'
import type { SessionView } from '@/lib/queries/session'
import { archivedSession, contextFor, replaySession } from '../nav/fixtures'
import { activeLive, liveState, replayReport, screenData, withToasts } from './fixtures'

// En un replay, el reporte de la sección 9 va en lugar del estado del bot (spec §11.1):
// las cifras, las quincenas, lo que hay que saber para leerlo (el sesgo de supervivencia
// y las señales que faltaron) y, en una hoja, el histograma de S′, la correlación entre
// señales y el universo por día.

vi.mock('@/lib/db', () => ({ db: {}, repos: {} }))
vi.mock('@/lib/actions/commands', () => ({ enqueueCommand: vi.fn(), cancelCommand: vi.fn(), releaseProtected: vi.fn() }))
vi.mock('@/lib/actions/settings', () => ({ setPause: vi.fn() }))

const live = vi.hoisted(() => ({ current: null as unknown as import('@/lib/live/provider').LiveState }))
vi.mock('@/lib/live/provider', () => ({ useLiveContext: () => live.current }))

vi.mock('next/navigation', () => ({
  usePathname: () => '/s/ses_replay',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}))

// Al abrir una hoja, Motion restaura el scroll con `window.scrollTo`, que jsdom no implementa.
beforeAll(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
})

beforeEach(() => {
  window.history.replaceState(null, '', '/s/ses_replay')
})

const SURVIVORSHIP = /^Las monedas salen de las que hoy cotizan en Binance/

function renderPast(session: SessionView, report: ResumenReportView | null) {
  live.current = liveState(activeLive({ sessionId: session.id, botStatus: null, offline: true }))
  return render(withToasts(<ResumenScreen data={screenData({ session, report })} context={contextFor(session)} />))
}

const reportSection = () => screen.getByRole('region', { name: 'Reporte' })

describe('el reporte de un replay en Resumen', () => {
  it('las quincenas, el sesgo de supervivencia y las señales que faltaron con sus fechas', () => {
    renderPast(replaySession(), resumenReportView(replayReport(), 0.35))
    const report = reportSection()

    const fortnights = within(report).getByRole('table', { name: 'Operaciones por quincena' })
    expect(within(fortnights).getAllByRole('row').map((r) => r.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('2 ago → 16 ago'), expect.stringContaining('17 ago → 31 ago')]),
    )
    expect(within(fortnights).getByText('12 operaciones · 7 ganadas')).toBeInTheDocument()

    expect(within(report).getByText(SURVIVORSHIP)).toBeInTheDocument()
    expect(within(report).getByText(/^Interés abierto y posicionamiento hay desde el 1 oct/)).toBeInTheDocument()

    const missing = within(report).getByRole('list', { name: 'Señales que faltaron' })
    expect(within(missing).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Funding: del 20 ago al 21 ago y el 5 sep, en 1 moneda',
      'Interés abierto: del 2 ago al 30 sep, en 3 monedas',
      'Posicionamiento: del 2 ago al 30 sep, en 3 monedas',
    ])
  })

  it('"Ver señales y universo" abre la hoja con el histograma de S′, la correlación y el universo por día', () => {
    renderPast(replaySession(), resumenReportView(replayReport(), 0.35))
    fireEvent.click(screen.getByRole('button', { name: 'Ver señales y universo' }))
    const sheet = screen.getByRole('dialog', { name: 'Señales y universo' })
    expect(window.location.search).toBe('?reporte=detalle')

    // El histograma: cuántas pasaron el umbral y, recorriéndolo, cada barra.
    expect(within(sheet).getByRole('heading', { name: 'Histograma de S′' })).toBeInTheDocument()
    const readout = within(sheet).getByText('El 41% de las decisiones (156 de 380) pasó el umbral.')
    const histogram = within(sheet).getByRole('group', { name: /^Histograma de S′/ })
    fireEvent.focus(histogram)
    expect(readout).toHaveTextContent('De −0,05 a 0: 19 decisiones.')
    fireEvent.keyDown(histogram, { key: 'ArrowRight' })
    expect(readout).toHaveTextContent('De 0 a 0,05: 19 decisiones.')
    fireEvent.click(within(sheet).getByRole('button', { name: 'Ver los valores del histograma' }))
    expect(within(sheet).getByRole('table', { name: 'Decisiones por valor de S′' })).toBeInTheDocument()

    // La correlación: los pares más parecidos y, al pedirlos, los 45.
    expect(within(sheet).getByText('Tendencia de 15 minutos y tendencia mayor')).toBeInTheDocument()
    expect(within(sheet).getByText('+0,82')).toBeInTheDocument()
    expect(within(sheet).queryByText('Funding y posicionamiento')).not.toBeInTheDocument()
    fireEvent.click(within(sheet).getByRole('button', { name: 'Ver los 45 pares' }))
    expect(within(sheet).getByText('Funding y posicionamiento')).toBeInTheDocument()

    // El universo por día.
    expect(within(sheet).getByText('3 monedas cada día, 4 distintas en los 3 días.')).toBeInTheDocument()
    expect(within(sheet).getByText('Entró PEPE. Salió SOL.')).toBeInTheDocument()
  })

  it('un replay sin el reporte del bot igual declara el sesgo de supervivencia', () => {
    renderPast(replaySession(), null)
    const report = reportSection()
    expect(within(report).getByText(SURVIVORSHIP)).toBeInTheDocument()
    expect(within(report).queryByRole('table', { name: 'Operaciones por quincena' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Ver señales y universo' })).not.toBeInTheDocument()
  })

  it('una simulación archivada no es un replay: sin advertencias de replay', () => {
    renderPast(archivedSession(), null)
    expect(within(reportSection()).queryByText(SURVIVORSHIP)).not.toBeInTheDocument()
  })
})
