import { render } from '@testing-library/react'
import { DEFAULT_SETTINGS, REAL_CHECK_IDS, type RealCheck, type Settings } from '@sereno/shared'
import { AjustesScreen, type AjustesScreenData } from '@/components/ajustes/ajustes-screen'
import { ToastProvider } from '@/components/ui/toast'
import { LiveProvider } from '@/lib/live/provider'
import type { LivePayload, OpenPositionView } from '@/lib/live/types'
import type { RealPanel } from '@/lib/queries/real'
import type { ReadinessView } from '@/lib/real-readiness'
import type { SessionView } from '@/lib/queries/session'
import { position } from '../fixtures'
import { liveSession, livePayload, NOW, withQueryClient } from '../nav/fixtures'

export const OWNER = 'owner@example.com'

/** Los ajustes por defecto con un cambio encima (copia profunda: los tests no se pisan). */
export function settingsWith(patch: (s: Settings) => void = () => {}): Settings {
  const settings = structuredClone(DEFAULT_SETTINGS)
  patch(settings)
  return settings
}

/** Modo "Yo fijo tamaño y salidas" con US$ 50 por trade, el ejemplo de la spec. */
export function customSettings(patch: (s: Settings) => void = () => {}): Settings {
  return settingsWith((s) => {
    s.mode = 'custom'
    s.custom.marginPerTrade = { kind: 'usd', value: 50 }
    patch(s)
  })
}

export function screenData(config: Settings = DEFAULT_SETTINGS, patch: Partial<AjustesScreenData> = {}): AjustesScreenData {
  return {
    session: liveSession(),
    settings: { config, version: 3, updatedAt: NOW - 3_600_000, updatedBy: OWNER },
    defaults: DEFAULT_SETTINGS,
    universe: {
      current: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
      available: [
        { symbol: 'BTCUSDT', name: 'BTC' },
        { symbol: 'ETHUSDT', name: 'ETH' },
        { symbol: 'SOLUSDT', name: 'SOL' },
        { symbol: 'DOGEUSDT', name: 'DOGE' },
      ],
      belowMinimum: [],
      excluded: {},
    },
    shieldedAt: null,
    accountTiers: null,
    real: realPanel(),
    ...patch,
  }
}

/** Los diez chequeos en verde, salvo los que se pisen por id. */
export function checks(patch: Partial<Record<RealCheck['id'], Pick<RealCheck, 'status' | 'detail'>>> = {}): RealCheck[] {
  return REAL_CHECK_IDS.map((id) => ({ id, status: 'ok', detail: '', ...patch[id] }))
}

/** Chequeos de testnet recién corridos, con la variable y las claves, todos en verde. */
export function readiness(patch: Partial<ReadinessView> = {}): ReadinessView {
  return { env: 'testnet', enabled: true, keysPresent: true, checks: checks(), checkedAt: NOW - 60_000, stale: false, walletAvailable: 120, ...patch }
}

/** Ajustes › Plata real: por defecto el bot todavía no revisó la cuenta. */
export function realPanel(patch: Partial<RealPanel> = {}): RealPanel {
  return {
    readiness: null,
    session: null,
    canCreate: { ok: false, missing: ['Que el bot revise tu cuenta de Binance (todavía no corrió los chequeos)'] },
    ...patch,
  }
}

/** Una abierta con lo que dejaría cerrarla ahora (`net`). */
export function openPosition(id: string, symbol: string, net: number): OpenPositionView {
  return {
    ...position(id, { symbol }),
    sessionId: 'ses_live',
    missingSignals: [],
    latencyMs: null,
    valuation: { mark: 125, unrealized: net, net, r: net / 5, pctOfMargin: net / 50 },
  }
}

/** Tres abiertas que, cerradas ahora, suman −US$ 8,40. */
export const THREE_OPEN: OpenPositionView[] = [
  openPosition('p1', 'SOLUSDT', -5.2),
  openPosition('p2', 'ETHUSDT', -4.1),
  openPosition('p3', 'AVAXUSDT', 0.9),
]

export interface RenderOptions {
  data?: AjustesScreenData
  live?: LivePayload
  readOnly?: boolean
  session?: SessionView
}

export function renderAjustes({ data = screenData(), live, readOnly = false }: RenderOptions = {}) {
  const payload = live ?? livePayload({ sessionId: data.session.id, settings: data.settings?.config ?? null })
  return render(
    withQueryClient(
      <ToastProvider>
        <LiveProvider sessionId={data.session.id} initial={payload} enabled={false}>
          <AjustesScreen data={data} readOnly={readOnly} email={OWNER} />
        </LiveProvider>
      </ToastProvider>,
    ),
  )
}
