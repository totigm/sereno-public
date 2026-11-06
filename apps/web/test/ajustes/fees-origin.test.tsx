import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { livePayload } from '../nav/fixtures'
import { renderAjustes, screenData, settingsWith } from './fixtures'

vi.mock('@/lib/db', () => ({ db: {}, repos: {} }))
vi.mock('@/lib/actions/settings', () => ({ updateSettings: vi.fn(), setPause: vi.fn() }))
vi.mock('@/lib/actions/commands', () => ({ enqueueCommand: vi.fn(), cancelCommand: vi.fn(), releaseProtected: vi.fn() }))
vi.mock('@/lib/actions/session', () => ({ archiveSession: vi.fn() }))
vi.mock('@/lib/actions/real', () => ({ createRealSession: vi.fn(), turnRealOff: vi.fn(), turnRealOn: vi.fn() }))
vi.mock('@/lib/auth-client', () => ({ authClient: { signOut: vi.fn() } }))
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/ajustes' }))

beforeEach(() => {
  for (const fn of Object.values(router)) fn.mockReset()
})

const AT = Date.parse('2026-11-01T03:10:00Z')
const ACCOUNT = { mmrBySymbol: { BTCUSDT: 0.004, SOLUSDT: 0.01 }, takerFeeRate: 0.00045, makerFeeRate: 0.00018 }
const withAccount = settingsWith((s) => {
  s.risk = { ...s.risk, ...ACCOUNT }
})

async function openRisk(): Promise<void> {
  await userEvent.setup().click(screen.getByRole('button', { name: 'Riesgo (avanzado)' }))
}

describe('Riesgo (avanzado): de dónde salen el mmr y las comisiones', () => {
  it('con los valores de la cuenta dice cuándo se actualizaron', async () => {
    renderAjustes({ data: screenData(withAccount, { accountTiers: { at: AT, ...ACCOUNT } }) })
    await openRisk()
    expect(screen.getByText('Comisiones y mmr: de tu cuenta de Binance · actualizado el 1 de noviembre.')).toBeInTheDocument()
  })

  it('sin datos de la cuenta son los supuestos', async () => {
    renderAjustes()
    await openRisk()
    expect(screen.getByText('Comisiones y mmr: supuestos (sin clave de Binance).')).toBeInTheDocument()
  })

  it('si Toti los cambió después, lo dice', async () => {
    const edited = settingsWith((s) => {
      s.risk = { ...s.risk, ...ACCOUNT, takerFeeRate: 0.0006 }
    })
    renderAjustes({ data: screenData(edited, { accountTiers: { at: AT, ...ACCOUNT } }) })
    await openRisk()
    expect(screen.getByText(/^Comisiones y mmr: los cambiaste a mano\./)).toBeInTheDocument()
  })
})

describe('Riesgo (avanzado): el bot guarda los de la cuenta con la pantalla abierta', () => {
  it('vuelve a leer la página para que el origen no diga que los cambió Toti', () => {
    renderAjustes({ data: screenData(), live: livePayload({ settingsVersion: 4, settings: withAccount }) })
    expect(router.refresh).toHaveBeenCalledTimes(1)
  })

  it('no la vuelve a leer si lo que cambió afuera no es el riesgo (la pausa automática)', () => {
    const paused = settingsWith((s) => {
      s.pause = { paused: true, by: 'auto', at: '2026-11-01T03:00:00.000Z', reason: 'drawdown' }
    })
    renderAjustes({ data: screenData(), live: livePayload({ settingsVersion: 4, settings: paused }) })
    expect(router.refresh).not.toHaveBeenCalled()
  })

  it('ni si la versión en vivo es la que ya trajo la página', () => {
    renderAjustes({ data: screenData(withAccount), live: livePayload({ settingsVersion: 3, settings: withAccount }) })
    expect(router.refresh).not.toHaveBeenCalled()
  })
})
