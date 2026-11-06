import { screen } from '@testing-library/react'
import { act, type ReactNode } from 'react'
import { hydrateRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ResumenScreen } from '@/components/resumen/resumen-screen'
import { SessionReport } from '@/components/resumen/session-report'
import { resumenReportView } from '@/lib/queries/resumen-report'
import { statsView } from '@/lib/queries/stats'
import { contextFor, liveSession, NOW, replaySession } from '../nav/fixtures'
import { activeLive, journal, journalEntry, liveState, replayReport, screenData, withToasts } from './fixtures'

// Una hoja abierta desde la URL (`?reporte=detalle`, `?diario=todo`) dibuja en un portal que
// el servidor no tiene: si se abriera al hidratar, React descartaría el HTML del servidor de
// la página (y la entrada de Resumen se cortaría). Se abre recién después de hidratar.

vi.mock('@/lib/db', () => ({ db: {}, repos: {} }))
vi.mock('@/lib/actions/commands', () => ({ enqueueCommand: vi.fn(), cancelCommand: vi.fn(), releaseProtected: vi.fn() }))
vi.mock('@/lib/actions/settings', () => ({ setPause: vi.fn() }))
vi.mock('@/lib/actions/session', () => ({ createSession: vi.fn() }))
const live = vi.hoisted(() => ({ current: null as unknown as import('@/lib/live/provider').LiveState }))
vi.mock('@/lib/live/provider', () => ({ useLiveContext: () => live.current }))
vi.mock('next/navigation', () => ({
  usePathname: () => window.location.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}))

beforeAll(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
})

const roots: Root[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.innerHTML = ''
  window.history.replaceState(null, '', '/')
})

/** Lo que dibuja el servidor (sin `document`, la hoja no dibuja nada), hidratado en `url`. */
async function hydrateAt(url: string, ui: ReactNode) {
  window.history.replaceState(null, '', url)
  const container = document.createElement('div')
  vi.stubGlobal('document', undefined)
  const html = renderToString(ui)
  vi.unstubAllGlobals()
  container.innerHTML = html
  document.body.append(container)
  const errors: unknown[] = []
  await act(async () => {
    roots.push(hydrateRoot(container, ui, { onRecoverableError: (error) => errors.push(error) }))
  })
  return errors
}

describe('una hoja abierta desde la URL', () => {
  it('la del reporte: hidrata sin rehacer la página y después se abre', async () => {
    const errors = await hydrateAt(
      '/s/ses_replay?reporte=detalle',
      <SessionReport
        session={replaySession()}
        stats={statsView([], { pct: 0, peakAt: null, troughAt: null, resolution: null })}
        realized={0}
        report={resumenReportView(replayReport(), 0.35)}
        now={NOW}
        statsHref="/s/ses_replay/posiciones?vista=estadisticas"
      />,
    )
    expect(errors).toEqual([])
    expect(screen.getByRole('dialog', { name: 'Señales y universo' })).toBeInTheDocument()
  })

  it('la del diario, con toda la pantalla: hidrata sin rehacerla y después se abre', async () => {
    live.current = liveState(activeLive())
    const session = liveSession()
    const entries = [journalEntry('j1', { text: 'Entrada 1.' })]
    const errors = await hydrateAt('/?diario=todo', withToasts(<ResumenScreen data={screenData({ session, journal: journal(entries) })} context={contextFor(session)} />))
    expect(errors).toEqual([])
    expect(screen.getByRole('dialog', { name: 'Lo último que hizo' })).toBeInTheDocument()
  })
})
