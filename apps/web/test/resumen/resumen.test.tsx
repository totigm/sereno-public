import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ResumenFirstRun } from '@/components/resumen/first-run'
import { ResumenScreen } from '@/components/resumen/resumen-screen'
import { LiveBands } from '@/components/shell/live-status'
import type { LivePayload } from '@/lib/live/types'
import { BOT, contextFor, liveSession, realSession, replaySession } from '../nav/fixtures'
import { activeLive, FIRST_RUN, ledger, liveState, offlineLive, screenData, withToasts } from './fixtures'

// Los cinco casos del brief de Task 27, con sus textos exactos.

vi.mock('@/lib/db', () => ({ db: {}, repos: {} }))
vi.mock('@/lib/actions/commands', () => ({ enqueueCommand: vi.fn(), cancelCommand: vi.fn(), releaseProtected: vi.fn() }))
vi.mock('@/lib/actions/settings', () => ({ setPause: vi.fn() }))
vi.mock('@/lib/actions/session', () => ({ createSession: vi.fn() }))

const live = vi.hoisted(() => ({ current: null as unknown as import('@/lib/live/provider').LiveState }))
vi.mock('@/lib/live/provider', () => ({ useLiveContext: () => live.current }))

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

function renderResumen(data: LivePayload, { replay = false } = {}) {
  live.current = liveState(data)
  const session = replay ? replaySession() : liveSession()
  // Las bandas van arriba de la pantalla, como las pone el shell en la simulación activa.
  return render(
    withToasts(
      <>
        {!replay && <LiveBands />}
        <ResumenScreen data={screenData({ session })} context={contextFor(session)} />
      </>,
    ),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('Resumen (brief de Task 27)', () => {
  it('el titular dice "Vas ganando US$ 247,80 desde el 14 de octubre." con los datos del ejemplo', () => {
    renderResumen(activeLive())
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Vas ganando US$ 247,80 desde el 14 de octubre.')
  })

  it('sin conexión: con el latido viejo aparece "Bot sin conexión desde las 14:32" y Pausar está deshabilitado', () => {
    renderResumen(offlineLive())
    expect(screen.getAllByRole('status').some((r) => /^Bot sin conexión desde las 14:32/.test(r.textContent ?? ''))).toBe(true)
    expect(screen.getByRole('button', { name: 'Pausar' })).toBeDisabled()
  })

  it('primer uso sin sesión: el formulario termina en "Empezar a simular"', () => {
    render(withToasts(<ResumenFirstRun data={FIRST_RUN} />))
    fireEvent.click(screen.getByRole('button', { name: 'Seguir' }))
    expect(screen.getByRole('button', { name: 'Empezar a simular' })).toBeInTheDocument()
  })

  it('en un replay el titular va en pasado ("Hubiera ganado") y no hay "Pausar"', () => {
    renderResumen(activeLive({ sessionId: 'ses_replay', botStatus: null, offline: true }), { replay: true })
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^Hubiera ganado US\$ 247,80/)
    expect(screen.queryByRole('button', { name: 'Pausar' })).not.toBeInTheDocument()
  })

  it('la tarjeta de capital en el estado 2 dice "Blindaste los US$ 1.000 iniciales"', () => {
    renderResumen(activeLive({ ledger: ledger({ protegido: 1000 }) }))
    const capital = screen.getByRole('region', { name: 'Tu capital' })
    expect(capital).toHaveTextContent(/Blindaste los US\$ 1\.000 iniciales/)
  })

  it('en "Tu capital" el monto de la frase va destacado, como en la Libreta', () => {
    renderResumen(activeLive({ ledger: ledger({ protegido: 1000 }) }))
    const amount = within(screen.getByRole('region', { name: 'Tu capital' })).getByText('US$ 1.000', { selector: 'strong' })
    expect(amount.closest('p')).toHaveTextContent(/^Blindaste los US\$ 1\.000 iniciales/)
  })
})

describe('Resumen de la sesión real', () => {
  it('los enlaces quedan en la sesión real y el estado dice en vivo que la apagó el tope', () => {
    // La página se dibujó prendida; el tope llega después, con la consulta en vivo.
    const session = realSession({ realStatus: 'on' })
    live.current = liveState(activeLive({ sessionId: 'ses_real', realStatus: 'loss_floor', botStatus: { ...BOT, real: { mode: 'reduce_only', missing: [] } } }))
    render(withToasts(<ResumenScreen data={screenData({ session })} context={contextFor(session)} />))
    const stats = screen.getAllByRole('link').filter((a) => a.getAttribute('href')?.includes('vista=estadisticas'))
    expect(stats.length).toBeGreaterThan(0)
    for (const link of stats) expect(link).toHaveAttribute('href', '/s/ses_real/posiciones?vista=estadisticas')
    expect(within(screen.getByRole('list', { name: 'Estado del bot' })).getByText('Apagada por el tope de pérdida')).toBeInTheDocument()
  })
})
