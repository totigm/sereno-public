import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DEFAULT_SETTINGS, type Settings } from '@sereno/shared'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { archivedSession, BOT, livePayload, replaySession } from '../nav/fixtures'
import { customSettings, openPosition, OWNER, renderAjustes, screenData, settingsWith, THREE_OPEN } from './fixtures'

// Las fixtures arman las sesiones con `toSessionView` (puro); el módulo trae la base, que acá no hace falta.
vi.mock('@/lib/db', () => ({ db: {}, repos: {} }))

const actions = vi.hoisted(() => ({
  updateSettings: vi.fn(),
  setPause: vi.fn(),
  enqueueCommand: vi.fn(),
  cancelCommand: vi.fn(),
  releaseProtected: vi.fn(),
  archiveSession: vi.fn(),
  signOut: vi.fn(),
}))
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }))

vi.mock('@/lib/actions/settings', () => ({ updateSettings: actions.updateSettings, setPause: actions.setPause }))
vi.mock('@/lib/actions/commands', () => ({
  enqueueCommand: actions.enqueueCommand,
  cancelCommand: actions.cancelCommand,
  releaseProtected: actions.releaseProtected,
}))
vi.mock('@/lib/actions/session', () => ({ archiveSession: actions.archiveSession }))
vi.mock('@/lib/actions/real', () => ({ createRealSession: vi.fn(), turnRealOff: vi.fn(), turnRealOn: vi.fn() }))
vi.mock('@/lib/auth-client', () => ({ authClient: { signOut: actions.signOut } }))
vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/ajustes' }))

// Con la clave de Binance la tabla de mmr trae todas las perpetuas: NEW (2,5%) está, aunque
// no esté en el tablero ni abierta. 10x y SL 7,5%: con 2% el short liquida a 7,84% (entra).
function withUntradedCoin(s: Settings): void {
  s.custom.leverage = 10
  s.custom.slPct = 0.075
  s.risk.mmrBySymbol = { ...s.risk.mmrBySymbol, NEWUSDT: 0.025 }
}

const CONFLICT = 'Los ajustes cambiaron mientras los editabas: te muestro la versión nueva.'

// Motion mide la altura `auto` de lo que se despliega y restaura el scroll con
// `window.scrollTo`, que jsdom no implementa (sólo avisa por consola).
beforeAll(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
})

beforeEach(() => {
  for (const fn of [...Object.values(actions), ...Object.values(router)]) fn.mockReset()
  actions.updateSettings.mockImplementation(async (_id: string, _patch: unknown, version: number) => ({ ok: true, version: version + 1 }))
  actions.setPause.mockImplementation(async (_id: string, _paused: boolean, version: number) => ({ ok: true, version: version + 1 }))
  actions.enqueueCommand.mockImplementation(async (input: { id: string }) => ({ ok: true, id: input.id, duplicate: false }))
  actions.releaseProtected.mockImplementation(async (input: { id: string }) => ({ ok: true, id: input.id, duplicate: false }))
  actions.archiveSession.mockResolvedValue({ ok: true, closed: 3, leftOpen: 0, markAt: null })
  actions.signOut.mockResolvedValue({ data: { success: true }, error: null })
})

describe('Capital', () => {
  it('la vista previa del blindaje es una frase con el porcentaje y el monto', () => {
    renderAjustes()
    expect(
      screen.getByText('Cuando la ganancia llegue a 70% (US$ 700), blindo los US$ 1.000 iniciales y sigo sólo con lo ganado.'),
    ).toBeInTheDocument()
  })

  it('la frase sigue lo que se escribe, y se guarda recién al salir del campo', async () => {
    const user = userEvent.setup()
    renderAjustes()
    const field = screen.getByRole('textbox', { name: 'Blindaje' })
    await user.clear(field)
    await user.type(field, '50')
    expect(
      screen.getByText('Cuando la ganancia llegue a 50% (US$ 500), blindo los US$ 1.000 iniciales y sigo sólo con lo ganado.'),
    ).toBeInTheDocument()
    expect(actions.updateSettings).not.toHaveBeenCalled()
    await user.tab()
    expect(actions.updateSettings).toHaveBeenCalledWith('ses_live', { capital: { ...DEFAULT_SETTINGS.capital, protectPct: 0.5 } }, 3)
  })

  it('un valor que el esquema rechaza muestra el error junto al campo y no se manda', async () => {
    const user = userEvent.setup()
    renderAjustes()
    const field = screen.getByRole('textbox', { name: 'Blindaje' })
    await user.clear(field)
    await user.type(field, '150{Enter}')
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(field).toHaveAccessibleDescription('Como máximo 100%.')
    expect(actions.updateSettings).not.toHaveBeenCalled()
  })

  it('con el capital blindado, "Volver a usar el capital blindado" pide confirmación y encola el comando', async () => {
    const user = userEvent.setup()
    const live = livePayload({ settings: DEFAULT_SETTINGS })
    live.ledger = { ...live.ledger, saldo: 1312, protegido: 1000 }
    renderAjustes({ live })
    expect(screen.getByText(/^Blindaste los US\$ 1\.000 iniciales/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Volver a usar el capital blindado' }))
    const dialog = screen.getByRole('dialog', { name: 'Volver a usar el capital blindado' })
    expect(dialog).toHaveTextContent(
      'Los US$ 1.000 blindados vuelven a operar. El blindaje vuelve a medir desde US$ 1.312: se dispara cuando ganes otros US$ 918,40 (70%).',
    )
    await user.click(within(dialog).getByRole('button', { name: 'Volver a usar' }))
    expect(actions.releaseProtected).toHaveBeenCalledWith({ id: expect.any(String), sessionId: 'ses_live' })
  })

  it('sin conexión, "Volver a usar el capital blindado" queda deshabilitado con la explicación', () => {
    const live = livePayload({ settings: DEFAULT_SETTINGS, offline: true })
    live.ledger = { ...live.ledger, saldo: 1312, protegido: 1000 }
    renderAjustes({ live })
    const button = screen.getByRole('button', { name: 'Volver a usar el capital blindado' })
    expect(button).toBeDisabled()
    expect(button).toHaveAccessibleDescription('El bot está sin conexión: vas a poder volver a usar el capital blindado cuando se conecte.')
  })
})

describe('Modo', () => {
  it('en "Yo fijo tamaño y salidas" aparecen los campos y la traducción del SL', async () => {
    const user = userEvent.setup()
    renderAjustes({ data: screenData(settingsWith((s) => (s.custom.marginPerTrade = { kind: 'usd', value: 50 }))) })
    expect(screen.getByText('En los dos casos el bot elige cuándo entrar y si es long o short.')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Stop loss' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('radio', { name: /Yo fijo tamaño y salidas/ }))
    expect(actions.updateSettings).toHaveBeenCalledWith('ses_live', { mode: 'custom' }, 3)
    for (const name of ['Margen por trade', 'Apalancamiento', 'Take profit', 'Stop loss', 'Posiciones máximas']) {
      expect(screen.getByRole('textbox', { name })).toBeInTheDocument()
    }
    expect(screen.getByRole('switch', { name: 'Trailing stop' })).toBeInTheDocument()
    expect(screen.getByRole('radiogroup', { name: 'Dirección' })).toBeInTheDocument()
    expect(screen.getByText('SL 2% del precio = −US$ 5 de los US$ 50 (−10%)')).toBeInTheDocument()
    expect(screen.getByText('TP 4% del precio = +US$ 10 de los US$ 50 (+20%)')).toBeInTheDocument()
    expect(await screen.findByText(/Vale para las posiciones nuevas, no para las abiertas\./)).toBeInTheDocument()
  })

  it('pasar a "Yo fijo tamaño y salidas" con un SL más allá de la liquidación no guarda: lo dice y muestra los campos', async () => {
    const user = userEvent.setup()
    // Guardados en modo automático cuando el mmr era más bajo: hoy con 10x la liquidación llega antes del SL de 12%.
    renderAjustes({ data: screenData(settingsWith((s) => Object.assign(s.custom, { leverage: 10, slPct: 0.12 }))) })
    await user.click(screen.getByRole('radio', { name: /Yo fijo tamaño y salidas/ }))
    expect(actions.updateSettings).not.toHaveBeenCalled()
    expect(screen.getByRole('radio', { name: /El bot decide todo/ })).toBeChecked()
    expect(screen.getByText(/^No pasé a “Yo fijo tamaño y salidas”: con 10x te liquidan a .* antes del SL: bajá el SL o el apalancamiento\.$/)).toHaveAttribute(
      'role',
      'alert',
    )
    // Los campos quedan a mano para corregirlos.
    const sl = screen.getByRole('textbox', { name: 'Stop loss' })
    await user.clear(sl)
    await user.type(sl, '5{Enter}')
    await user.click(screen.getByRole('radio', { name: /Yo fijo tamaño y salidas/ }))
    expect(actions.updateSettings).toHaveBeenLastCalledWith('ses_live', { mode: 'custom' }, 4)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('la traducción cambia mientras se escribe el SL', async () => {
    const user = userEvent.setup()
    renderAjustes({ data: screenData(customSettings()) })
    const sl = screen.getByRole('textbox', { name: 'Stop loss' })
    await user.clear(sl)
    await user.type(sl, '3')
    expect(screen.getByText('SL 3% del precio = −US$ 7,50 de los US$ 50 (−15%)')).toBeInTheDocument()
  })

  it('con apalancamiento 10 y SL 12% avisa que la liquidación llega antes y no guarda', async () => {
    const user = userEvent.setup()
    renderAjustes({ data: screenData(customSettings((s) => (s.custom.leverage = 10))) })
    const sl = screen.getByRole('textbox', { name: 'Stop loss' })
    await user.clear(sl)
    await user.type(sl, '12')
    const warning = 'Con 10x te liquidan a 7,8% del precio (mmr de 2%), antes del SL: bajá el SL o el apalancamiento.'
    expect(screen.getByRole('alert')).toHaveTextContent(warning)
    await user.tab()
    expect(actions.updateSettings).not.toHaveBeenCalled()
    expect(sl).toHaveAttribute('aria-invalid', 'true')
  })

  it('subir el apalancamiento hasta que la liquidación pase el SL tampoco se guarda', async () => {
    const user = userEvent.setup()
    renderAjustes({ data: screenData(customSettings((s) => (s.custom.slPct = 0.12))) })
    const leverage = screen.getByRole('textbox', { name: 'Apalancamiento' })
    await user.clear(leverage)
    await user.type(leverage, '10{Enter}')
    expect(leverage).toHaveAccessibleDescription(/Con 10x te liquidan a 7,8% del precio/)
    expect(actions.updateSettings).not.toHaveBeenCalled()
  })

  it('el mmr de una moneda que el bot no puede operar no bloquea el guardado', async () => {
    const user = userEvent.setup()
    const config = customSettings(withUntradedCoin)
    renderAjustes({ data: screenData(config) })
    const tp = screen.getByRole('textbox', { name: 'Take profit' })
    await user.clear(tp)
    await user.type(tp, '6')
    await user.tab()
    expect(actions.updateSettings).toHaveBeenCalledWith('ses_live', { custom: { ...config.custom, tpPct: 0.06 } }, 3)
  })

  it('con una abierta en esa moneda, su mmr sí cuenta', async () => {
    const config = customSettings(withUntradedCoin)
    renderAjustes({ data: screenData(config), live: livePayload({ settings: config, open: [openPosition('p1', 'NEWUSDT', 0)] }) })
    expect(screen.getByRole('textbox', { name: 'Stop loss' })).toHaveAccessibleDescription(/Con 10x te liquidan a 7,3% del precio \(mmr de 2,5%\)/)
  })
})

describe('Guardado', () => {
  it('cada cambio muestra el toast con "Deshacer", y deshacer escribe el valor anterior', async () => {
    const user = userEvent.setup()
    renderAjustes()
    await user.click(screen.getByRole('switch', { name: 'Reinvertir ganancias' }))
    expect(actions.updateSettings).toHaveBeenLastCalledWith('ses_live', { capital: { ...DEFAULT_SETTINGS.capital, reinvest: false } }, 3)
    expect(await screen.findByText('Guardado: reinversión apagada.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Deshacer' }))
    await waitFor(() =>
      expect(actions.updateSettings).toHaveBeenLastCalledWith('ses_live', { capital: DEFAULT_SETTINGS.capital }, 4),
    )
    expect(await screen.findByText('Volví al valor anterior.')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Reinvertir ganancias' })).toHaveAttribute('aria-checked', 'true')
  })

  it('sin conexión el toast avisa que el bot lo toma cuando vuelva', async () => {
    const user = userEvent.setup()
    renderAjustes({ live: livePayload({ offline: true, botStatus: { ...BOT, lastHeartbeat: BOT.lastHeartbeat - 600_000 } }) })
    await user.click(screen.getByRole('switch', { name: 'Reinvertir ganancias' }))
    expect(await screen.findByText('Guardado: reinversión apagada. El bot lo toma cuando vuelva.')).toBeInTheDocument()
  })

  it('con una versión vieja avisa del conflicto y recarga los valores vigentes', async () => {
    const user = userEvent.setup()
    const current = settingsWith((s) => (s.capital.protectPct = 0.5))
    actions.updateSettings.mockResolvedValueOnce({ ok: false, reason: 'conflict', message: CONFLICT, version: 5, settings: current })
    renderAjustes()
    await user.click(screen.getByRole('switch', { name: 'Reinvertir ganancias' }))
    expect(await screen.findByText(CONFLICT)).toBeInTheDocument()
    expect(
      screen.getByText('Cuando la ganancia llegue a 50% (US$ 500), blindo los US$ 1.000 iniciales y sigo sólo con lo ganado.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Reinvertir ganancias' })).toHaveAttribute('aria-checked', 'true')

    // El siguiente guardado ya sale con la versión que se recargó.
    await user.click(screen.getByRole('switch', { name: 'Reinvertir ganancias' }))
    expect(actions.updateSettings).toHaveBeenLastCalledWith('ses_live', { capital: { ...current.capital, reinvest: false } }, 5)
  })

  it('dice si el bot ya aplicó la versión vigente', () => {
    renderAjustes()
    expect(screen.getByText('El bot ya aplicó estos ajustes.')).toBeInTheDocument()
  })
})

describe('Riesgo (avanzado)', () => {
  it('arranca plegado; abierto muestra los valores por defecto y "Restablecer"', async () => {
    const user = userEvent.setup()
    renderAjustes({ data: screenData(settingsWith((s) => (s.risk.maxLeverage = 3))) })
    const toggle = screen.getByRole('button', { name: 'Riesgo (avanzado)' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('textbox', { name: 'Riesgo por trade' })).not.toBeInTheDocument()

    await user.click(toggle)
    expect(screen.getByRole('textbox', { name: 'Riesgo por trade' })).toHaveValue('1')
    expect(screen.getByRole('textbox', { name: 'Apalancamiento máximo' })).toHaveValue('3')
    expect(screen.getByText('Por defecto 5x')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Comisión taker' })).toHaveValue('0,05')

    await user.click(screen.getByRole('button', { name: 'Restablecer' }))
    expect(actions.updateSettings).toHaveBeenCalledWith('ses_live', { risk: DEFAULT_SETTINGS.risk }, 3)
  })

  it('"Restablecer" no guarda si con el mmr por defecto la liquidación llega antes del SL del modo propio', async () => {
    const user = userEvent.setup()
    // Con mmr 0,1% el SL de 8,5% a 10x queda antes de la liquidación; con el 2% por defecto, no.
    const config = customSettings((s) => {
      Object.assign(s.custom, { leverage: 10, slPct: 0.085 })
      s.risk.mmrDefault = 0.001
      s.risk.mmrBySymbol = {}
    })
    renderAjustes({ data: screenData(config) })
    await user.click(screen.getByRole('button', { name: 'Riesgo (avanzado)' }))
    await user.click(screen.getByRole('button', { name: 'Restablecer' }))
    expect(actions.updateSettings).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(/^Con 10x te liquidan a .* \(mmr de 2%\), antes del SL: bajá el SL o el apalancamiento\.$/)
  })

  it('en modo custom, cambiar un mmr no se bloquea por una moneda que el bot no puede operar', async () => {
    const user = userEvent.setup()
    const config = customSettings(withUntradedCoin)
    renderAjustes({ data: screenData(config) })
    await user.click(screen.getByRole('button', { name: 'Riesgo (avanzado)' }))
    const eth = screen.getByRole('textbox', { name: 'ETH' })
    await user.clear(eth)
    await user.type(eth, '0,6{Enter}')
    expect(actions.updateSettings).toHaveBeenCalledWith('ses_live', { risk: { ...config.risk, mmrBySymbol: { ...config.risk.mmrBySymbol, ETHUSDT: 0.006 } } }, 3)
  })

  it('con los valores por defecto no hay nada que restablecer', async () => {
    const user = userEvent.setup()
    renderAjustes()
    await user.click(screen.getByRole('button', { name: 'Riesgo (avanzado)' }))
    expect(screen.getByRole('button', { name: 'Restablecer' })).toBeDisabled()
  })
})

describe('Universo', () => {
  it('fijar una moneda la guarda en la lista y se puede sacar', async () => {
    const user = userEvent.setup()
    renderAjustes()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Fijar una moneda' }), 'DOGEUSDT')
    expect(actions.updateSettings).toHaveBeenLastCalledWith(
      'ses_live',
      { universe: { ...DEFAULT_SETTINGS.universe, pinned: ['DOGEUSDT'] } },
      3,
    )
    await user.click(await screen.findByRole('button', { name: 'Sacar DOGE de las fijadas' }))
    await waitFor(() =>
      expect(actions.updateSettings).toHaveBeenLastCalledWith('ses_live', { universe: DEFAULT_SETTINGS.universe }, 4),
    )
  })

  it('dice qué monedas quedan fuera por el mínimo del contrato', () => {
    const data = screenData()
    data.universe.excluded = { ETHUSDT: { reason: 'below_min_notional', detail: '20' } }
    renderAjustes({ data })
    expect(screen.getByText('ETH: el mínimo de Binance es US$ 20, más de lo que permite tu capital.')).toBeInTheDocument()
  })
})

describe('Bot', () => {
  it('"Cerrar todo" abre la confirmación con el total y encola el comando', async () => {
    const user = userEvent.setup()
    renderAjustes({ live: livePayload({ open: THREE_OPEN }) })
    await user.click(screen.getByRole('button', { name: 'Cerrar todo' }))
    const dialog = screen.getByRole('dialog', { name: 'Cerrar todo' })
    expect(dialog).toHaveTextContent('Vas a cerrar 3 posiciones por −US$ 8,40.')
    await user.click(within(dialog).getByRole('button', { name: 'Cerrar todo' }))
    expect(actions.enqueueCommand).toHaveBeenCalledWith({ id: expect.any(String), sessionId: 'ses_live', kind: 'close_all', payload: {} })
  })

  it('"Nueva simulación" confirma con el texto del spec, archiva y lleva al primer uso', async () => {
    const user = userEvent.setup()
    renderAjustes({ live: livePayload({ open: THREE_OPEN }) })
    await user.click(screen.getByRole('button', { name: 'Nueva simulación' }))
    const dialog = screen.getByRole('dialog', { name: 'Nueva simulación' })
    expect(dialog).toHaveTextContent('La actual queda guardada y la podés volver a ver. Las 3 abiertas se cierran al precio actual.')
    await user.click(within(dialog).getByRole('button', { name: 'Empezar una nueva' }))
    expect(actions.archiveSession).toHaveBeenCalledWith({ sessionId: 'ses_live' })
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/'))
  })

  it('sin un precio actual, ofrece archivar sin cerrar las abiertas', async () => {
    const user = userEvent.setup()
    const stale = 'No tengo un precio actual para cerrar las abiertas (el último es de las 14:32). Podés esperar a que el bot vuelva o archivar sin cerrarlas.'
    actions.archiveSession.mockResolvedValueOnce({ ok: false, reason: 'stale_mark', message: stale, markAt: null })
    renderAjustes({ live: livePayload({ open: THREE_OPEN }) })
    await user.click(screen.getByRole('button', { name: 'Nueva simulación' }))
    await user.click(screen.getByRole('button', { name: 'Empezar una nueva' }))
    const dialog = await screen.findByRole('dialog', { name: 'Nueva simulación' })
    expect(within(dialog).getByText(stale)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Archivar sin cerrarlas' }))
    expect(actions.archiveSession).toHaveBeenLastCalledWith({ sessionId: 'ses_live', closeOpen: false })
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/'))
  })

  it('pausar guarda la pausa con "Deshacer", que vuelve a escribir la pausa anterior', async () => {
    const user = userEvent.setup()
    renderAjustes({ live: livePayload({ open: THREE_OPEN }) })
    await user.click(screen.getByRole('button', { name: 'Pausar' }))
    expect(actions.setPause).toHaveBeenCalledWith('ses_live', true, 3)
    expect(await screen.findByText('Bot pausado. Sigo cuidando las 3 abiertas.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reanudar' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Deshacer' }))
    await waitFor(() => expect(actions.updateSettings).toHaveBeenLastCalledWith('ses_live', { pause: DEFAULT_SETTINGS.pause }, 4))
    expect(await screen.findByRole('button', { name: 'Pausar' })).toBeInTheDocument()
  })

  it('sin conexión, pausar y cerrar todo quedan deshabilitados con la explicación', () => {
    renderAjustes({ live: livePayload({ open: THREE_OPEN, offline: true }) })
    expect(screen.getByRole('button', { name: 'Pausar' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cerrar todo' })).toBeDisabled()
    expect(screen.getByText('El bot está sin conexión: pausar y cerrar todo vuelven cuando se conecte.')).toBeInTheDocument()
  })
})

describe('Plata real y cuenta', () => {
  it('sin chequeos la plata real está apagada, dice qué falta y que todo es ficticio', () => {
    renderAjustes()
    const section = screen.getByRole('region', { name: 'Plata real' })
    expect(within(section).getByText('Apagado')).toBeInTheDocument()
    expect(section).toHaveTextContent('todo lo de esta simulación es ficticio')
    expect(section).toHaveTextContent('El bot todavía no revisó tu cuenta de Binance.')
    expect(within(section).getByRole('button', { name: 'Empezar con plata real' })).toBeDisabled()
  })

  it('en un replay no aparece', () => {
    renderAjustes({ data: screenData(customSettings(), { session: replaySession(), real: null }), readOnly: true })
    expect(screen.queryByRole('region', { name: 'Plata real' })).not.toBeInTheDocument()
  })

  it('muestra el email y "Cerrar sesión" vuelve a la pantalla de acceso', async () => {
    const user = userEvent.setup()
    renderAjustes()
    expect(screen.getByText(OWNER)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cerrar sesión' }))
    expect(actions.signOut).toHaveBeenCalled()
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/acceso'))
  })
})

describe('Contexto replay y archivada', () => {
  it('en un replay todo es sólo lectura y sin acciones sobre el bot', () => {
    renderAjustes({ data: screenData(customSettings(), { session: replaySession() }), readOnly: true })
    expect(screen.getByText('Así estaban los ajustes de este replay. Son de sólo lectura.')).toBeInTheDocument()
    expect(screen.queryAllByRole('textbox')).toHaveLength(0)
    expect(screen.queryAllByRole('switch')).toHaveLength(0)
    expect(screen.queryAllByRole('radio')).toHaveLength(0)
    expect(screen.queryAllByRole('combobox')).toHaveLength(0)
    for (const name of ['Pausar', 'Cerrar todo', 'Nueva simulación', 'Restablecer', 'Volver a usar el capital blindado']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
    }
    // Los valores se leen igual, en pasado donde corresponde.
    expect(screen.getByText('Yo fijo tamaño y salidas')).toBeInTheDocument()
    expect(screen.getByText('Blindaba los US$ 1.000 iniciales al llegar a US$ 700 de ganancia.')).toBeInTheDocument()
    expect(screen.getByText('Las de más volumen en 24 h. Al final eran 3.')).toBeInTheDocument()
    expect(screen.getByText('Ninguna moneda quedaba fuera por el mínimo con ese capital.')).toBeInTheDocument()
    expect(screen.queryByText('El bot ya aplicó estos ajustes.')).not.toBeInTheDocument()
  })

  it('en una simulación archivada también, con su copy', () => {
    renderAjustes({ data: screenData(DEFAULT_SETTINGS, { session: archivedSession() }), readOnly: true })
    expect(screen.getByText('Así estaban los ajustes de esta simulación. Son de sólo lectura.')).toBeInTheDocument()
    expect(screen.queryAllByRole('textbox')).toHaveLength(0)
  })
})
