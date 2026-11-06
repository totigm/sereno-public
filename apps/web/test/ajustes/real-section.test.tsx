import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DEFAULT_SETTINGS } from '@sereno/shared'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { BOT, livePayload, realSession } from '../nav/fixtures'
import { checks, readiness, realPanel, renderAjustes, screenData, settingsWith } from './fixtures'

// Las fixtures arman las sesiones con `toSessionView` (puro); el módulo trae la base, que acá no hace falta.
vi.mock('@/lib/db', () => ({ db: {}, repos: {} }))

const actions = vi.hoisted(() => ({
  createRealSession: vi.fn(),
  turnRealOff: vi.fn(),
  turnRealOn: vi.fn(),
  updateSettings: vi.fn(),
  cancelCommand: vi.fn(),
}))
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }))

vi.mock('@/lib/actions/real', () => ({ createRealSession: actions.createRealSession, turnRealOff: actions.turnRealOff, turnRealOn: actions.turnRealOn }))
vi.mock('@/lib/actions/settings', () => ({ updateSettings: actions.updateSettings, setPause: vi.fn() }))
vi.mock('@/lib/actions/commands', () => ({ enqueueCommand: vi.fn(), cancelCommand: actions.cancelCommand, releaseProtected: vi.fn() }))
vi.mock('@/lib/actions/session', () => ({ archiveSession: vi.fn() }))
vi.mock('@/lib/auth-client', () => ({ authClient: { signOut: vi.fn() } }))
vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/ajustes' }))

const OFF_TEXT = 'Cierro todas las posiciones del bot a mercado, cancelo sus órdenes y dejo de operar. Las tuyas no las toco.'
const CAP_TEXT =
  'El tope se cuida con stops. Si el precio salta de golpe más allá de un stop, la pérdida puede pasar un poco el tope; el margen aislado la limita a lo que puso cada posición.'

beforeAll(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
})

beforeEach(() => {
  for (const fn of [...Object.values(actions), ...Object.values(router)]) fn.mockReset()
  actions.createRealSession.mockResolvedValue({ ok: true, sessionId: 'ses_real' })
  actions.turnRealOff.mockImplementation(async (input: { id: string }) => ({ ok: true, id: input.id, duplicate: false }))
  actions.turnRealOn.mockResolvedValue({ ok: true })
  actions.updateSettings.mockImplementation(async (_id: string, _patch: unknown, version: number) => ({ ok: true, version: version + 1 }))
})

function section(): HTMLElement {
  return screen.getByRole('region', { name: 'Plata real' })
}

describe('Plata real, desde la simulación en papel', () => {
  it('con un chequeo en fail el botón está apagado y lista la etiqueta', () => {
    const failing = readiness({ checks: checks({ one_way: { status: 'fail', detail: 'La cuenta está en modo cobertura.' } }) })
    renderAjustes({ data: screenData(DEFAULT_SETTINGS, { real: realPanel({ readiness: failing, canCreate: { ok: false, missing: ['La cuenta está en modo de una posición por moneda'] } }) }) })
    expect(within(section()).getByRole('button', { name: 'Empezar con plata real' })).toBeDisabled()
    expect(section()).toHaveTextContent('Para prenderlo falta:')
    const missing = within(section()).getByRole('list', { name: 'Para prenderlo falta:' })
    expect(missing).toHaveTextContent('La cuenta está en modo de una posición por moneda')
    // En la lista de chequeos, el que falló dice por qué.
    expect(section()).toHaveTextContent('La cuenta está en modo cobertura.')
  })

  it('con readiness vieja aparece el aviso', () => {
    renderAjustes({ data: screenData(DEFAULT_SETTINGS, { real: realPanel({ readiness: readiness({ stale: true }) }) }) })
    expect(section()).toHaveTextContent('Hace más de 15 minutos que el bot no revisa: los chequeos pueden estar viejos.')
  })

  it('dice el entorno: "Testnet" o "Binance real"', () => {
    const { unmount } = renderAjustes({ data: screenData(DEFAULT_SETTINGS, { real: realPanel({ readiness: readiness(), canCreate: { ok: true } }) }) })
    expect(within(section()).getByText('Testnet')).toBeInTheDocument()
    unmount()
    renderAjustes({ data: screenData(DEFAULT_SETTINGS, { real: realPanel({ readiness: readiness({ env: 'mainnet' }), canCreate: { ok: true } }) }) })
    expect(within(section()).getByText('Binance real')).toBeInTheDocument()
  })

  it('la confirmación con "40" para capital 50 no habilita', async () => {
    const user = userEvent.setup()
    renderAjustes({ data: screenData(DEFAULT_SETTINGS, { real: realPanel({ readiness: readiness(), canCreate: { ok: true } }) }) })
    await user.type(within(section()).getByLabelText('Capital asignado'), '50')
    await user.click(within(section()).getByRole('button', { name: 'Empezar con plata real' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Escribí 50 para confirmar que vas a operar con US$ 50 de verdad.')
    const confirm = within(dialog).getByRole('button', { name: 'Empezar con plata real' })
    await user.type(within(dialog).getByRole('textbox'), '40')
    expect(confirm).toBeDisabled()
    await user.clear(within(dialog).getByRole('textbox'))
    await user.type(within(dialog).getByRole('textbox'), '50')
    expect(confirm).toBeEnabled()
    await user.click(confirm)
    await waitFor(() => expect(actions.createRealSession).toHaveBeenCalledWith({ capital: 50, lossCap: 0.5, confirmation: '50' }))
    expect(router.push).toHaveBeenCalledWith('/s/ses_real/ajustes')
  })

  it('con una real prendida no ofrece crear otra y lleva a ella', () => {
    const session = { id: 'ses_real', status: 'on' as const, capital: 50, lossCap: 0.5, env: 'testnet' as const, gate: { mode: 'trading' as const, missing: [] }, openPositions: 0 }
    renderAjustes({ data: screenData(DEFAULT_SETTINGS, { real: realPanel({ readiness: readiness(), session, canCreate: { ok: false, missing: [] } }) }) })
    expect(within(section()).queryByRole('button', { name: 'Empezar con plata real' })).not.toBeInTheDocument()
    expect(within(section()).getByRole('link', { name: 'Ver la sesión con plata real' })).toHaveAttribute('href', '/s/ses_real/ajustes')
  })
})

describe('Plata real, en la sesión real', () => {
  const real = realSession()
  const lossCap = settingsWith((s) => {
    s.risk.lossCap = 0.5
  })
  function panel(patch: Partial<NonNullable<ReturnType<typeof realPanel>['session']>> = {}) {
    const session = { id: 'ses_real', status: 'on' as const, capital: 50, lossCap: 0.5, env: 'testnet' as const, gate: { mode: 'trading' as const, missing: [] }, openPositions: 0, ...patch }
    return realPanel({ readiness: readiness(), session, canCreate: { ok: false, missing: [] } })
  }
  function renderReal(p = panel(), live = livePayload({ sessionId: 'ses_real', settings: lossCap, botStatus: { ...BOT, real: p.session?.gate ?? null } })) {
    return renderAjustes({ data: screenData(lossCap, { session: real, real: p }), live })
  }

  it('"Cerrar todo y apagar" llama a turnRealOff', async () => {
    const user = userEvent.setup()
    renderReal()
    await user.click(within(section()).getByRole('button', { name: 'Cerrar todo y apagar' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent(OFF_TEXT)
    await user.click(within(dialog).getByRole('button', { name: 'Cerrar todo y apagar' }))
    await waitFor(() => expect(actions.turnRealOff).toHaveBeenCalledWith({ id: expect.any(String), sessionId: 'ses_real' }))
  })

  it('no ofrece nueva simulación ni archivar, y avisa cómo se cuida el tope', () => {
    renderReal()
    expect(screen.queryByRole('button', { name: 'Nueva simulación' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Bot' })).not.toBeInTheDocument()
    expect(section()).toHaveTextContent(CAP_TEXT)
    expect(within(section()).getByLabelText('Tope de pérdida')).toHaveValue('50')
  })

  it('el capital es el que asignaste de tu cuenta, no el de una simulación', () => {
    renderReal()
    const capital = screen.getByRole('region', { name: 'Capital' })
    expect(capital).toHaveTextContent('Lo asignaste de tu cuenta de futuros al crear la sesión.')
    expect(capital).not.toHaveTextContent('simulación')
  })

  it('sin claves y sin guardia, lo dice en rojo', () => {
    const p = panel({ gate: { mode: 'unguarded', missing: ['las claves de operación'] } })
    renderReal({ ...p, readiness: readiness({ keysPresent: false, checks: checks({ keys: { status: 'fail', detail: '' } }) }) })
    const warning = within(section()).getByText(
      'El bot no puede hablar con Binance: lo único que protege tus posiciones son los stops y take profit que ya están puestos allá.',
    )
    expect(warning).toHaveClass('text-loss')
  })

  it('después del tope no se puede prender', () => {
    renderReal(panel({ status: 'loss_floor', gate: { mode: 'reduce_only', missing: ['una sesión nueva (tocó el tope de pérdida)'] } }))
    expect(section()).toHaveTextContent('Apagada por el tope de pérdida. Para seguir, empezá una sesión nueva con un capital nuevo.')
    expect(within(section()).queryByRole('button', { name: 'Prender' })).not.toBeInTheDocument()
    // Lo que sigue es empezar otra: apagar ya no es la acción principal.
    expect(within(section()).getByRole('link', { name: 'Empezar otra' })).toHaveClass('bg-ink')
    expect(within(section()).getByRole('button', { name: 'Cerrar todo y apagar' })).toHaveClass('bg-surface', 'border-line')
  })

  it('después del tope, "Empezar otra" lleva a crear la nueva en la misma pantalla, sin pasar por la simulación', async () => {
    const user = userEvent.setup()
    const p = panel({ status: 'loss_floor', gate: { mode: 'reduce_only', missing: ['una sesión nueva (tocó el tope de pérdida)'] } })
    renderReal({ ...p, canCreate: { ok: true } })
    const start = within(section()).getByRole('link', { name: 'Empezar otra' })
    const target = start.getAttribute('href')?.replace(/^#/, '') ?? ''
    const form = document.getElementById(target)
    expect(form).not.toBeNull()
    expect(section()).toContainElement(form)
    expect(form).toHaveTextContent('La sesión con plata real anterior queda guardada, con su historia, y se puede volver a ver.')

    await user.type(within(section()).getByLabelText('Capital asignado'), '30')
    await user.click(within(section()).getByRole('button', { name: 'Empezar con plata real' }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByRole('textbox'), '30')
    await user.click(within(dialog).getByRole('button', { name: 'Empezar con plata real' }))
    await waitFor(() => expect(actions.createRealSession).toHaveBeenCalledWith({ capital: 30, lossCap: 0.5, confirmation: '30' }))
    expect(router.push).toHaveBeenCalledWith('/s/ses_real/ajustes')
  })

  it('prendida o apagada a mano, desde adentro no ofrece crear otra', () => {
    const { unmount } = renderReal()
    expect(within(section()).queryByLabelText('Capital asignado')).not.toBeInTheDocument()
    unmount()
    renderReal(panel({ status: 'off', gate: { mode: 'reduce_only', missing: ['prenderla en Ajustes'] } }))
    expect(within(section()).queryByLabelText('Capital asignado')).not.toBeInTheDocument()
  })

  it('apagada a mano se prende escribiendo el monto', async () => {
    const user = userEvent.setup()
    renderReal(panel({ status: 'off', gate: { mode: 'reduce_only', missing: ['prenderla en Ajustes'] } }))
    await user.click(within(section()).getByRole('button', { name: 'Prender' }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByRole('textbox'), '50')
    await user.click(within(dialog).getByRole('button', { name: 'Prender' }))
    await waitFor(() => expect(actions.turnRealOn).toHaveBeenCalledWith({ sessionId: 'ses_real', confirmation: '50' }))
  })

  it('después de prenderla, la próxima confirmación arranca vacía', async () => {
    const user = userEvent.setup()
    renderReal(panel({ status: 'off', gate: { mode: 'reduce_only', missing: ['prenderla en Ajustes'] } }))
    await user.click(within(section()).getByRole('button', { name: 'Prender' }))
    const first = await screen.findByRole('dialog')
    await user.type(within(first).getByRole('textbox'), '50')
    await user.click(within(first).getByRole('button', { name: 'Prender' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    // Un toque no alcanza para volver a operar con plata real: hay que escribir el monto otra vez.
    await user.click(within(section()).getByRole('button', { name: 'Prender' }))
    const again = await screen.findByRole('dialog')
    expect(within(again).getByRole('textbox')).toHaveValue('')
    expect(within(again).getByRole('button', { name: 'Prender' })).toBeDisabled()
  })
})
