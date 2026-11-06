import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { DEFAULT_SETTINGS } from '@sereno/shared'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ResumenFirstRun } from '@/components/resumen/first-run'
import { ResumenScreen } from '@/components/resumen/resumen-screen'
import type { LivePayload } from '@/lib/live/types'
import type { JournalEntry } from '@/lib/queries/journal'
import { contextFor, liveSession, NOW, replaySession } from '../nav/fixtures'
import { openView } from '../posiciones/helpers'
import { activeLive, AT_1432, DAY, FIRST_RUN, journal, journalEntry, ledger, liveState, offlineLive, screenData, withToasts } from './fixtures'

// Lo que se hace desde Resumen: pausar, cerrar todo, volver a usar el capital, el diario
// completo, la banda de liquidaciones y el primer uso (spec §11.1).

vi.mock('@/lib/db', () => ({ db: {}, repos: {} }))

// Al abrir una hoja, Motion restaura el scroll con `window.scrollTo`, que jsdom no
// implementa (sólo avisa por consola).
beforeAll(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
})

const actions = vi.hoisted(() => ({
  enqueueCommand: vi.fn(),
  cancelCommand: vi.fn(),
  releaseProtected: vi.fn(),
  setPause: vi.fn(),
  createSession: vi.fn(),
}))
vi.mock('@/lib/actions/commands', () => ({
  enqueueCommand: actions.enqueueCommand,
  cancelCommand: actions.cancelCommand,
  releaseProtected: actions.releaseProtected,
}))
vi.mock('@/lib/actions/settings', () => ({ setPause: actions.setPause }))
vi.mock('@/lib/actions/session', () => ({ createSession: actions.createSession }))

const live = vi.hoisted(() => ({ current: null as unknown as import('@/lib/live/provider').LiveState }))
vi.mock('@/lib/live/provider', () => ({ useLiveContext: () => live.current }))

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}))

function renderScreen(data: LivePayload, { replay = false, entries = [] as JournalEntry[] } = {}) {
  live.current = liveState(data)
  const session = replay ? replaySession() : liveSession()
  return render(withToasts(<ResumenScreen data={screenData({ session, journal: journal(entries) })} context={contextFor(session)} />))
}

const twoOpen = () => [
  openView('pos-sol', { symbol: 'SOLUSDT', openedAt: NOW - 3 * 3_600_000 }, { net: 12.4 }),
  openView('pos-eth', { symbol: 'ETHUSDT', side: 'short', openedAt: NOW - 3_600_000 }, { net: -3.1 }),
]

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  window.history.replaceState(null, '', '/')
  actions.setPause.mockResolvedValue({ ok: true, version: 4 })
  actions.enqueueCommand.mockImplementation(async ({ id }: { id: string }) => ({ ok: true, id, duplicate: false }))
  actions.releaseProtected.mockImplementation(async ({ id }: { id: string }) => ({ ok: true, id, duplicate: false }))
})

describe('pausar y reanudar', () => {
  it('sin abiertas pausa directo, con "Deshacer", y el botón pasa a "Reanudar"', async () => {
    renderScreen(activeLive())
    fireEvent.click(screen.getByRole('button', { name: 'Pausar' }))
    expect(actions.setPause).toHaveBeenCalledWith('ses_live', true, 3)
    expect(screen.getByRole('button', { name: 'Reanudar' })).toBeInTheDocument()
    expect(await screen.findByText('Bot pausado.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Deshacer' })).toBeInTheDocument()
  })

  it('con abiertas pregunta qué hacer; "Pausar y cerrar todo" pausa y manda cerrar todo', async () => {
    renderScreen(activeLive({ open: twoOpen() }))
    fireEvent.click(screen.getByRole('button', { name: 'Pausar' }))
    const sheet = await screen.findByRole('dialog', { name: 'Pausar el bot' })
    expect(within(sheet).getByRole('button', { name: 'Pausar (sigo cuidando las 2 abiertas)' })).toBeInTheDocument()
    expect(within(sheet).getByText('Vas a cerrar 2 posiciones por +US$ 9,30.')).toBeInTheDocument()

    fireEvent.click(within(sheet).getByRole('button', { name: 'Pausar y cerrar todo' }))
    await waitFor(() => expect(actions.enqueueCommand).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'ses_live', kind: 'close_all' })))
    expect(actions.setPause).toHaveBeenCalledWith('ses_live', true, 3)
    expect(await screen.findByText('Bot pausado. Enviado al bot: cierra las 2 abiertas.')).toBeInTheDocument()
  })

  it('pausado por vos: "Reanudar" lo pone en marcha', () => {
    const settings = { ...DEFAULT_SETTINGS, pause: { paused: true, by: 'user' as const, at: new Date(AT_1432).toISOString(), reason: null } }
    renderScreen(activeLive({ settings }))
    expect(screen.getByText('Pausado por vos desde las 14:32')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reanudar' }))
    expect(actions.setPause).toHaveBeenCalledWith('ses_live', false, 3)
  })
})

describe('tu capital', () => {
  const pausedByShield = { ...DEFAULT_SETTINGS, pause: { paused: true, by: 'auto' as const, at: null, reason: 'capital blindado y sin ganancia para operar' } }

  it('estado 3: "Volver a usar el capital blindado" con confirmación', async () => {
    renderScreen(activeLive({ settings: pausedByShield, ledger: ledger({ protegido: 1000, saldo: 1004 }) }))
    expect(screen.getByRole('region', { name: 'Tu capital' })).toHaveTextContent(/El bot se pausó: los US\$ 1\.000 están blindados/)
    fireEvent.click(screen.getByRole('button', { name: 'Volver a usar el capital blindado' }))
    const confirm = await screen.findByRole('dialog', { name: 'Volver a usar el capital blindado' })
    fireEvent.click(within(confirm).getByRole('button', { name: 'Volver a usar' }))
    await waitFor(() => expect(actions.releaseProtected).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'ses_live' })))
  })

  it('estado 3: "Reanudar" no es la acción principal y avisa que se vuelve a pausar', () => {
    renderScreen(activeLive({ settings: pausedByShield, ledger: ledger({ protegido: 1000, saldo: 1004 }) }))
    const resume = screen.getByRole('button', { name: 'Reanudar' })
    expect(resume).not.toHaveClass('bg-ink')
    expect(resume).toHaveAccessibleDescription('Si lo reanudás sin ganancia para operar, se vuelve a pausar: para que siga, volvé a usar el capital blindado.')
  })

  it('sin conexión la acción queda deshabilitada con la explicación', () => {
    renderScreen(offlineLive({ settings: pausedByShield, ledger: ledger({ protegido: 1000, saldo: 1004 }) }))
    expect(screen.getByRole('button', { name: 'Volver a usar el capital blindado' })).toBeDisabled()
    expect(screen.getByText('El bot está sin conexión: lo vas a poder hacer cuando vuelva.')).toBeInTheDocument()
  })
})

describe('lo último que hizo', () => {
  const entries = Array.from({ length: 7 }, (_, i) =>
    journalEntry(`e${i}`, { at: AT_1432 - i * 6 * 3_600_000, text: `Entrada ${i}.` }),
  )

  it('muestra el tramo y cinco entradas; "Ver todo" abre el día agrupado', async () => {
    renderScreen(activeLive(), { entries })
    expect(screen.getByText('Desde ayer: 4 operaciones, 3 ganadas, +US$ 22,10. Miré 30 monedas 32 veces.')).toBeInTheDocument()
    expect(screen.getByText('Entrada 4.')).toBeInTheDocument()
    expect(screen.queryByText('Entrada 5.')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Ver todo' }))
    const sheet = await screen.findByRole('dialog', { name: 'Lo último que hizo' })
    expect(within(sheet).getByText('Entrada 6.')).toBeInTheDocument()
    expect(within(sheet).getByRole('heading', { name: 'Hoy' })).toBeInTheDocument()
    expect(within(sheet).getByRole('heading', { name: 'Ayer' })).toBeInTheDocument()
    expect(window.location.search).toBe('?diario=todo')
  })

  it('una liquidación va destacada y deja la banda hasta tocarla', async () => {
    const liquidation = journalEntry('liq:1', { kind: 'liquidation', text: 'Me liquidaron el long en DOGE: −US$ 50,00.', highlight: true, positionId: null })
    renderScreen(activeLive(), { entries: [liquidation] })
    // La banda repite su texto en la región viva (oculta para la vista): se busca ahí.
    await waitFor(() => expect(screen.getAllByRole('status').some((r) => r.textContent === 'Hubo 1 liquidación desde ayer.')).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: 'Ver' }))
    await waitFor(() => expect(screen.queryAllByText('Hubo 1 liquidación desde ayer.')).toHaveLength(0))
    expect(JSON.parse(window.localStorage.getItem('sereno:liquidaciones-vistas') ?? '[]')).toEqual(['liq:1'])
  })
})

describe('contexto', () => {
  it('en vivo: la línea secundaria y la tabla de la curva', () => {
    renderScreen(activeLive())
    expect(screen.getByText(/^Cerrado/).closest('p')).toHaveTextContent('Cerrado +247,80 · hoy +38,20 · 14 de 23 ganados')
    fireEvent.click(screen.getByRole('button', { name: 'Ver los valores' }))
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getAllByRole('row').length).toBeGreaterThan(1)
  })

  it('en un replay: "Abiertas al final", el reporte en lugar del estado y sin acciones', () => {
    renderScreen(activeLive({ sessionId: 'ses_replay', botStatus: null, offline: true, open: twoOpen() }), { replay: true })
    expect(screen.getByRole('heading', { name: 'Abiertas al final' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Reporte' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Estado del bot' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cerrar ahora' })).not.toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Todo' })).toHaveAttribute('aria-checked', 'true')
  })

  it('sin conexión, cerrar una abierta no se puede y se explica', () => {
    renderScreen(offlineLive({ open: twoOpen() }))
    expect(screen.getByText('El bot está sin conexión: no puede cerrar posiciones hasta que vuelva.')).toBeInTheDocument()
  })
})

describe('primer uso', () => {
  it('crea la simulación con lo elegido en los dos pasos', async () => {
    actions.createSession.mockResolvedValue({ ok: true, sessionId: 'ses_new', archived: null })
    render(withToasts(<ResumenFirstRun data={FIRST_RUN} />))
    fireEvent.change(screen.getByLabelText('Capital inicial'), { target: { value: '2.500' } })
    fireEvent.click(screen.getByRole('radio', { name: '50%' }))
    expect(screen.getByText('Cuando la ganancia llegue a 50% (US$ 1.250), blindo los US$ 2.500 iniciales y sigo sólo con lo ganado.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Seguir' }))
    expect(screen.getByRole('radio', { name: 'El bot decide todo' })).toBeChecked()
    fireEvent.click(screen.getByRole('radio', { name: 'Yo fijo tamaño y salidas' }))
    fireEvent.click(screen.getByRole('button', { name: 'Empezar a simular' }))
    await waitFor(() =>
      expect(actions.createSession).toHaveBeenCalledWith({ capital: 2500, protectPct: 0.5, mode: 'custom', learningOrigin: 'zero' }),
    )
  })

  it('un capital que no se entiende frena en el primer paso', () => {
    render(withToasts(<ResumenFirstRun data={FIRST_RUN} />))
    fireEvent.change(screen.getByLabelText('Capital inicial'), { target: { value: 'mil' } })
    fireEvent.click(screen.getByRole('button', { name: 'Seguir' }))
    expect(screen.getByText('Escribí un monto en dólares, por ejemplo 1.000.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Empezar a simular' })).not.toBeInTheDocument()
  })

  it('con replays hay un tercer paso para elegir de dónde arranca el aprendizaje', async () => {
    actions.createSession.mockResolvedValue({ ok: true, sessionId: 'ses_new', archived: null })
    const replays = [{ id: 'rep_1', name: 'Replay · 90 días', days: 90, capitalInicial: 1000, endedAt: NOW - DAY }]
    render(withToasts(<ResumenFirstRun data={{ ...FIRST_RUN, learningSources: { continued: false, replays } }} />))
    fireEvent.click(screen.getByRole('button', { name: 'Seguir' }))
    fireEvent.click(screen.getByRole('button', { name: 'Seguir' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Lo aprendido en Replay · 90 días (terminó el 30 de octubre)' }))
    fireEvent.click(screen.getByRole('button', { name: 'Empezar a simular' }))
    await waitFor(() => expect(actions.createSession).toHaveBeenCalledWith(expect.objectContaining({ learningOrigin: 'replay:rep_1' })))
  })
})
