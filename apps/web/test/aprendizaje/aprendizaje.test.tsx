import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AprendizajeScreen } from '@/components/aprendizaje/aprendizaje-screen'
import { resetCommandStatus } from '@/components/aprendizaje/controls'
import { AprendizajeFirstRun } from '@/components/aprendizaje/first-run'
import { ReplaysList } from '@/components/aprendizaje/replays-list'
import { ResetLearning } from '@/components/aprendizaje/reset-learning'
import { ShadowCompare } from '@/components/aprendizaje/shadow-compare'
import { cancelCommand, enqueueCommand, resetLearning, runReplay } from '@/lib/actions/commands'
import { updateSettings } from '@/lib/actions/settings'
import type { CommandView } from '@/lib/live/types'
import { contextOf } from '@/lib/queries/session'
import { livePayload, liveSession, replaySession } from '../nav/fixtures'
import {
  aprendizajeData,
  comparison,
  FINISHED_REPLAY,
  logEntry,
  NOW,
  queuedCommand,
  RUNNING_REPLAY,
  summary,
  withScreen,
  withToasts,
} from './fixtures'

// Las fixtures arman las sesiones con `toSessionView` (puro); el módulo trae la base, que acá no hace falta.
vi.mock('@/lib/db', () => ({ db: {}, repos: {} }))

vi.mock('@/lib/actions/commands', () => ({
  enqueueCommand: vi.fn(async ({ id }: { id: string }) => ({ ok: true, id, duplicate: false })),
  cancelCommand: vi.fn(async () => ({ ok: true })),
  resetLearning: vi.fn(async ({ id }: { id: string }) => ({ ok: true, id, duplicate: false })),
  runReplay: vi.fn(async ({ id }: { id: string }) => ({ ok: true, id, duplicate: false })),
}))

vi.mock('@/lib/actions/settings', () => ({
  updateSettings: vi.fn(async (_id: string, _patch: unknown, version: number) => ({ ok: true, version: version + 1 })),
}))

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }))

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => window.location.pathname,
  useSearchParams: () => new URLSearchParams(window.location.search),
}))

const ACTIVE = contextOf(liveSession())
const OFFLINE_RESET = 'El bot está sin conexión: lo podés reiniciar cuando vuelva.'

beforeEach(() => {
  vi.clearAllMocks()
  window.history.replaceState(null, '', '/aprendizaje')
})

describe('qué cambió', () => {
  it('con 23 trades cerrados dice que está juntando datos: 23 de 50', () => {
    render(withScreen(<AprendizajeScreen data={aprendizajeData()} context={ACTIVE} />))
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('juntando datos: 23 de 50')
    expect(screen.getByText('WIF queda en penitencia 7 días: confianza −0,45 tras 8 trades.')).toBeInTheDocument()
  })

  it('sin trades ni cambios, el vacío del primer uso', () => {
    const data = aprendizajeData({ progress: { closedTrades: 0, minTrades: 50, collecting: true }, log: { entries: [], nextCursor: null } })
    render(withScreen(<AprendizajeScreen data={data} context={ACTIVE} />))
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Todavía no aprendí nada: necesito trades cerrados')
  })

  it('sin simulación todavía, el mismo vacío y la invitación a empezar', () => {
    render(withToasts(<AprendizajeFirstRun sessions={[summary(FINISHED_REPLAY, { pnl: 576.41, trades: 128, won: 80 })]} now={NOW} />))
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Todavía no aprendí nada: necesito trades cerrados')
    expect(screen.getByRole('link', { name: 'Empezar a simular' })).toHaveAttribute('href', '/')
    // Sin simulación activa no hay a quién pedirle un replay, pero los que hubo se pueden abrir.
    expect(screen.getByRole('link', { name: 'Replay 90 días' })).toHaveAttribute('href', '/s/rep_listo')
    expect(screen.queryByRole('button', { name: 'Correr un replay' })).not.toBeInTheDocument()
  })
})

describe('originales contra aprendidos', () => {
  const shadow = (patch: Parameters<typeof comparison>[0]) => ({ ...aprendizajeData().shadow!, comparison: comparison(patch) })
  const compare = (patch: Parameters<typeof comparison>[0], extra: Partial<Parameters<typeof ShadowCompare>[0]> = {}) =>
    withScreen(<ShadowCompare shadow={shadow(patch)} startingPoint={null} session={liveSession()} canAct past={false} offline={false} now={NOW} {...extra} />)

  it('muestra la diferencia en puntos y avisa cuando los originales vienen ganando', () => {
    render(compare({ gapPp: 3.2, warn: true }))
    // La cifra va siempre del lado de los originales (como el aviso): + es que van por encima.
    expect(screen.getByText('+3,2 puntos')).toBeInTheDocument()
    expect(screen.getByText('Los originales van por encima de lo aprendido en los últimos 14 días, sobre el capital inicial.')).toBeInTheDocument()
    expect(screen.getByText(/más de 3 puntos por encima de lo aprendido/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reiniciar aprendizaje' })).toBeEnabled()
  })

  it('sin aviso cuando `warn` es falso, y la suma de R de cada cartera', () => {
    render(compare({ gapPp: -1.8, warn: false }))
    expect(screen.getByText('−1,8 puntos')).toBeInTheDocument()
    expect(screen.getByText('Los originales van por debajo de lo aprendido en los últimos 14 días, sobre el capital inicial.')).toBeInTheDocument()
    expect(screen.queryByText(/más de 3 puntos por encima/)).not.toBeInTheDocument()
    expect(screen.getByText('+4,5R')).toBeInTheDocument()
    expect(screen.getByText('+9,8R')).toBeInTheDocument()
  })

  it('en un replay el aviso queda en pasado y sin acciones', () => {
    render(compare({ gapPp: 3.2, warn: true }, { session: replaySession(), canAct: false, past: true }))
    expect(screen.getByText('Los originales quedaron por encima de lo aprendido en sus últimos 14 días, sobre el capital inicial.')).toBeInTheDocument()
    expect(screen.getByText(/rindieron más de 3 puntos por encima de lo aprendido/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reiniciar aprendizaje' })).not.toBeInTheDocument()
  })

  it('sin el bot, el aviso no ofrece reiniciar y dice por qué', () => {
    render(compare({ gapPp: 3.2, warn: true }, { offline: true }))
    expect(screen.getByRole('button', { name: 'Reiniciar aprendizaje' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Reiniciar aprendizaje' })).toHaveAccessibleDescription(OFFLINE_RESET)
  })
})

describe('replays', () => {
  const list = (extra: Partial<Parameters<typeof ReplaysList>[0]> = {}) =>
    withToasts(
      <ReplaysList
        sessions={[summary(RUNNING_REPLAY), summary(FINISHED_REPLAY, { pnl: 576.41, trades: 128, won: 80 })]}
        queued={[]}
        commands={[]}
        canAct
        activeSessionId="ses_live"
        defaultCapital={1000}
        offline={false}
        now={NOW}
        {...extra}
      />,
    )

  it('un replay corriendo muestra su progreso y se puede cancelar', async () => {
    render(list())
    const row = screen.getByText('Simulando · día 41 de 90').closest('li')!
    expect(within(row).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '46')
    await userEvent.click(within(row).getByRole('button', { name: 'Cancelar' }))
    expect(enqueueCommand).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'ses_live', kind: 'cancel_replay', payload: { replaySessionId: 'rep_corriendo' } }),
    )
  })

  it('un replay terminado enlaza a su sesión con el resumen', () => {
    render(list())
    const link = screen.getByRole('link', { name: 'Replay 90 días' })
    expect(link).toHaveAttribute('href', '/s/rep_listo')
    expect(screen.getByText(/\+US\$ 576,41/)).toBeInTheDocument()
  })

  it('un pedido que el bot todavía no tomó se cancela sacándolo de la cola', async () => {
    render(list({ queued: [queuedCommand()] }))
    const row = screen.getByText(/esperando al bot/).closest('li')!
    await userEvent.click(within(row).getByRole('button', { name: 'Cancelar' }))
    expect(cancelCommand).toHaveBeenCalledWith('7c1d8a52-8f0e-4a43-9d38-0d1c0b6f2b11')
  })

  it('"Correr un replay" abre la hoja con días, capital, aprendizaje y ajuste de parámetros', async () => {
    render(list())
    await userEvent.click(screen.getByRole('button', { name: 'Correr un replay' }))
    const sheet = await screen.findByRole('dialog', { name: 'Correr un replay' })
    expect(window.location.search).toBe('?replay=nuevo')
    expect(within(sheet).getByLabelText('Días')).toHaveValue('90')
    expect(within(sheet).getByLabelText('Capital inicial')).toHaveValue('1.000')
    const learning = within(sheet).getByRole('radiogroup', { name: 'Aprendizaje' })
    expect(within(learning).getByRole('radio', { name: 'Desde cero' })).toHaveAttribute('aria-checked', 'true')
    expect(within(learning).getByRole('radio', { name: 'El vigente' })).toBeInTheDocument()
    expect(within(sheet).getByRole('switch', { name: 'Ajustar parámetros cada semana' })).toHaveAttribute('aria-checked', 'false')
    expect(within(sheet).queryByText(/queda en cola/)).not.toBeInTheDocument()

    const days = within(sheet).getByLabelText('Días')
    await userEvent.clear(days)
    await userEvent.type(days, '30')
    await userEvent.click(within(learning).getByRole('radio', { name: 'El vigente' }))
    await userEvent.click(within(sheet).getByRole('button', { name: 'Correr el replay' }))
    expect(runReplay).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'ses_live', days: 30, capital: 1000, learningOrigin: 'current', paramTuning: false }),
    )
  })

  it('con días fuera de rango no lo pide y dice qué corregir', async () => {
    render(list())
    await userEvent.click(screen.getByRole('button', { name: 'Correr un replay' }))
    const sheet = await screen.findByRole('dialog', { name: 'Correr un replay' })
    const days = within(sheet).getByLabelText('Días')
    await userEvent.clear(days)
    await userEvent.type(days, '400')
    await userEvent.click(within(sheet).getByRole('button', { name: 'Correr el replay' }))
    expect(runReplay).not.toHaveBeenCalled()
    expect(within(sheet).getByText('Elegí entre 1 y 365 días.')).toBeInTheDocument()
  })

  it('con el bot sin conexión la hoja avisa que queda en cola y lo pide igual', async () => {
    const live = livePayload({ offline: true })
    render(withScreen(<AprendizajeScreen data={aprendizajeData({ live })} context={ACTIVE} />, live))
    await userEvent.click(screen.getByRole('button', { name: 'Correr un replay' }))
    const sheet = await screen.findByRole('dialog', { name: 'Correr un replay' })
    expect(within(sheet).getByText('El bot está sin conexión: el replay queda en cola y arranca cuando vuelva.')).toBeInTheDocument()
    await userEvent.click(within(sheet).getByRole('button', { name: 'Correr el replay' }))
    expect(runReplay).toHaveBeenCalledTimes(1)
  })

  it('si el bot no pudo cancelarlo, deja de decir "Cancelando…" y cuenta qué pasó', async () => {
    const { rerender } = render(list())
    const row = () => screen.getByRole('link', { name: 'Replay 90 días con lo aprendido' }).closest('li')!
    await userEvent.click(within(row()).getByRole('button', { name: 'Cancelar' }))
    expect(within(row()).getByText('Cancelando…')).toBeInTheDocument()

    const { id } = vi.mocked(enqueueCommand).mock.calls[0]![0]
    const answer = (patch: Partial<CommandView>) =>
      queuedCommand({ id, kind: 'cancel_replay', payload: { replaySessionId: 'rep_corriendo' }, ...patch })
    // Mientras el bot lo tiene, sigue cancelando.
    rerender(list({ commands: [answer({ status: 'claimed' })] }))
    expect(within(row()).getByText('Cancelando…')).toBeInTheDocument()

    rerender(list({ commands: [answer({ status: 'failed', result: { ok: false, message: 'No encontré ese replay.' } })] }))
    expect(within(row()).queryByText('Cancelando…')).not.toBeInTheDocument()
    expect(within(row()).getByText('Simulando · día 41 de 90')).toBeInTheDocument()
    expect(within(row()).getByText('No encontré ese replay.')).toBeInTheDocument()
    expect(within(row()).getByRole('button', { name: 'Cancelar' })).toBeEnabled()
  })

  it('si el cancel_replay salió de los últimos comandos del vivo, no queda "Cancelando…" para siempre', async () => {
    const { rerender } = render(list())
    const row = () => screen.getByRole('link', { name: 'Replay 90 días con lo aprendido' }).closest('li')!
    await userEvent.click(within(row()).getByRole('button', { name: 'Cancelar' }))
    // Recién pedido, el vivo todavía no lo trae: cancelando.
    rerender(list({ commands: [queuedCommand({ id: 'cmd_viejo', kind: 'reset_learning', payload: {}, createdAt: NOW - 60_000 })] }))
    expect(within(row()).getByText('Cancelando…')).toBeInTheDocument()

    // Diez comandos posteriores al pedido y el suyo no está: manda la sesión, que sigue simulando.
    const newer = Array.from({ length: 10 }, (_, i) => queuedCommand({ id: `cmd_${i}`, kind: 'reset_learning', payload: {}, createdAt: NOW + 1000 + i }))
    rerender(list({ commands: newer, now: NOW + 20_000 }))
    expect(within(row()).queryByText('Cancelando…')).not.toBeInTheDocument()
    expect(within(row()).getByText('Simulando · día 41 de 90')).toBeInTheDocument()
    expect(within(row()).getByRole('button', { name: 'Cancelar' })).toBeEnabled()
  })

  it('si no puede volver a pedir el replay que sacó de la cola, "Deshacer" lo dice', async () => {
    vi.mocked(runReplay).mockResolvedValueOnce({ ok: false, reason: 'not_active', message: 'Esta simulación ya no está activa: no cambié nada.' })
    render(list({ queued: [queuedCommand()] }))
    const row = screen.getByText(/esperando al bot/).closest('li')!
    await userEvent.click(within(row).getByRole('button', { name: 'Cancelar' }))
    const toast = await screen.findByText('Saqué el replay de la cola.')
    await userEvent.click(within(toast.closest('[role="status"]') as HTMLElement).getByRole('button', { name: 'Deshacer' }))
    expect(runReplay).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'ses_live', days: 30, capital: 2000 }))
    expect(await screen.findByText('Esta simulación ya no está activa: no cambié nada.')).toBeInTheDocument()
  })

  it('la hoja abre sola si la URL lo pide (?replay=nuevo)', async () => {
    window.history.replaceState(null, '', '/aprendizaje?replay=nuevo')
    render(list())
    expect(await screen.findByRole('dialog', { name: 'Correr un replay' })).toBeInTheDocument()
  })

  it('fuera de la simulación activa no hay acciones', () => {
    render(list({ canAct: false }))
    expect(screen.getByText('Simulando · día 41 de 90')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancelar' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Correr un replay' })).not.toBeInTheDocument()
  })
})

describe('controles', () => {
  it('congelar guarda el ajuste y ofrece deshacer', async () => {
    render(withScreen(<AprendizajeScreen data={aprendizajeData()} context={ACTIVE} />))
    await userEvent.click(screen.getByRole('switch', { name: 'Congelar aprendizaje' }))
    expect(updateSettings).toHaveBeenCalledWith('ses_live', { learning: expect.objectContaining({ frozen: true }) }, 3)
    const toast = await screen.findByText('Congelé el aprendizaje.')
    await userEvent.click(within(toast.closest('[role="status"]') as HTMLElement).getByRole('button', { name: 'Deshacer' }))
    expect(updateSettings).toHaveBeenLastCalledWith('ses_live', { learning: expect.objectContaining({ frozen: false }) }, 4)
  })

  it('el reinicio en cola sin conexión habla del bot en tercera persona, como el resto de la pantalla', () => {
    const pending = queuedCommand({ kind: 'reset_learning', payload: {} })
    expect(resetCommandStatus(pending, true)).toBe('En cola · el bot lo toma cuando vuelva')
    expect(resetCommandStatus(pending, false)).toBe('Enviado al bot…')
  })

  it('reiniciar pide confirmación antes de mandar el comando', async () => {
    render(withScreen(<AprendizajeScreen data={aprendizajeData()} context={ACTIVE} />))
    await userEvent.click(screen.getByRole('button', { name: 'Reiniciar…' }))
    expect(resetLearning).not.toHaveBeenCalled()
    const confirm = await screen.findByRole('dialog', { name: 'Reiniciar aprendizaje' })
    await act(async () => {
      await userEvent.click(within(confirm).getByRole('button', { name: 'Reiniciar aprendizaje' }))
    })
    expect(resetLearning).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'ses_live' }))
  })

  it('si el bot se queda sin conexión con la confirmación abierta, no reinicia y dice por qué', async () => {
    const reset = (offline: boolean) =>
      withToasts(<ResetLearning sessionId="ses_live" closedTrades={23} label="Reiniciar…" offline={offline} offlineNoteId="nota-sin-bot" />)
    const { rerender } = render(reset(false))
    await userEvent.click(screen.getByRole('button', { name: 'Reiniciar…' }))
    const confirm = await screen.findByRole('dialog', { name: 'Reiniciar aprendizaje' })
    rerender(reset(true))
    await act(async () => {
      await userEvent.click(within(confirm).getByRole('button', { name: 'Reiniciar aprendizaje' }))
    })
    expect(resetLearning).not.toHaveBeenCalled()
    expect(await screen.findByText(OFFLINE_RESET)).toBeInTheDocument()
  })

  it('en un replay, copy en pasado y ningún control sobre el bot', () => {
    const replay = replaySession()
    const data = aprendizajeData({
      session: replay,
      progress: { closedTrades: 128, minTrades: 50, collecting: false },
      sessions: [summary(liveSession()), summary(RUNNING_REPLAY)],
    })
    render(withScreen(<AprendizajeScreen data={data} context={contextOf(replay)} />))
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Aprendí de 128 trades cerrados')
    expect(screen.queryByRole('switch', { name: 'Congelar aprendizaje' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reiniciar…' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Correr un replay' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancelar' })).not.toBeInTheDocument()
    // La simulación en curso se abre en las rutas raíz, no bajo `/s/<id>`.
    expect(screen.getByRole('link', { name: /Simulación en curso/ })).toHaveAttribute('href', '/')
  })

  it('un replay que todavía corre muestra su avance en lugar de lo aprendido', () => {
    const data = aprendizajeData({ session: RUNNING_REPLAY, sessions: [] })
    render(withScreen(<AprendizajeScreen data={data} context={contextOf(RUNNING_REPLAY)} />))
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Este replay todavía está corriendo.')
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '46')
    expect(screen.queryByText(/juntando datos/)).not.toBeInTheDocument()
  })
})

describe('señales y monedas', () => {
  it('fiabilidad sin dato, acierto y peso; la penitencia con su fecha de vuelta', () => {
    render(withScreen(<AprendizajeScreen data={aprendizajeData()} context={ACTIVE} />))
    const table = screen.getByRole('table', { name: 'Señales' })
    const trend = within(table).getByRole('row', { name: /Tendencia de 15 minutos/ })
    expect(trend).toHaveTextContent('+0,12')
    expect(trend).toHaveTextContent('58%')
    expect(trend).toHaveTextContent('1,12')
    expect(within(table).getByRole('row', { name: /Momentum/ })).toHaveTextContent('sin dato')
    expect(screen.getByText('En penitencia hasta el 3 nov')).toBeInTheDocument()
  })
})

describe('sin conexión', () => {
  const live = livePayload({ offline: true })

  it('lo que necesita al bot queda deshabilitado con la explicación; correr un replay y congelar no', () => {
    const data = aprendizajeData({ live, queuedReplays: [queuedCommand()] })
    render(withScreen(<AprendizajeScreen data={data} context={ACTIVE} />, live))

    const reset = screen.getByRole('button', { name: 'Reiniciar…' })
    expect(reset).toBeDisabled()
    expect(reset).toHaveAccessibleDescription(OFFLINE_RESET)

    const running = screen.getByText('Simulando · día 41 de 90').closest('li')!
    const cancel = within(running).getByRole('button', { name: 'Cancelar' })
    expect(cancel).toBeDisabled()
    expect(cancel).toHaveAccessibleDescription('El bot está sin conexión: lo podés cancelar cuando vuelva.')

    // Sacar de la cola un pedido que el bot no tomó no lo necesita; un replay nuevo queda en cola (spec §11.1.4).
    const queued = screen.getByText(/arranca cuando el bot vuelva/).closest('li')!
    expect(within(queued).getByRole('button', { name: 'Cancelar' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Correr un replay' })).toBeEnabled()

    // Congelar es un ajuste: se guarda y el bot lo toma al volver (spec §10).
    expect(screen.getByRole('switch', { name: 'Congelar aprendizaje' })).toBeEnabled()
    expect(screen.getByText('El bot está sin conexión: si lo cambiás, queda guardado y lo toma cuando vuelva.')).toBeInTheDocument()
  })
})

describe('un replay que corre, en su propia página', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    return () => vi.useRealTimers()
  })

  it('se vuelve a leer cada 10 s aunque la consulta en vivo esté quieta', () => {
    const data = aprendizajeData({ session: RUNNING_REPLAY, sessions: [] })
    render(withScreen(<AprendizajeScreen data={data} context={contextOf(RUNNING_REPLAY)} />))
    expect(router.refresh).not.toHaveBeenCalled()
    act(() => void vi.advanceTimersByTime(10_000))
    expect(router.refresh).toHaveBeenCalledTimes(1)
    act(() => void vi.advanceTimersByTime(10_000))
    expect(router.refresh).toHaveBeenCalledTimes(2)
  })

  it('uno terminado ya no se vuelve a leer', () => {
    const data = aprendizajeData({ session: FINISHED_REPLAY, sessions: [], progress: { closedTrades: 128, minTrades: 50, collecting: false } })
    render(withScreen(<AprendizajeScreen data={data} context={contextOf(FINISHED_REPLAY)} />))
    act(() => void vi.advanceTimersByTime(30_000))
    expect(router.refresh).not.toHaveBeenCalled()
  })
})

describe('objetivos táctiles', () => {
  it('en el celu ningún botón de la pantalla mide menos de 44 px (h-11); en desktop se compactan', () => {
    const data = aprendizajeData({
      log: { entries: [1, 2, 3, 4, 5, 6].map((id) => logEntry(id)), nextCursor: null },
      shadow: { ...aprendizajeData().shadow!, comparison: comparison({ gapPp: 3.2, warn: true }) },
      coins: Array.from({ length: 9 }, (_, i) => ({ symbol: `C${i}USDT`, name: `C${i}`, confidence: 0.1, multiplier: 1, trades: 3, penaltyUntil: null })),
      queuedReplays: [queuedCommand()],
    })
    render(withScreen(<AprendizajeScreen data={data} context={ACTIVE} />))
    const buttons = screen.getAllByRole('button')
    expect(buttons.map((b) => b.textContent)).toEqual(
      expect.arrayContaining(['Ver todo el diario', 'Reiniciar aprendizaje', 'Ver las 9 monedas', 'Reiniciar…', 'Correr un replay', 'Cancelar']),
    )
    for (const button of buttons) {
      expect(button).toHaveClass('h-11')
      expect(button).toHaveClass('desktop:h-9')
    }
  })
})
