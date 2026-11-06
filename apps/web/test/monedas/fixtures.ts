import { SIGNAL_IDS, type Position, type SignalId } from '@sereno/core'
import type { MarketSymbolView } from '@sereno/db'
import { DEFAULT_SETTINGS, type Settings } from '@sereno/shared'
import type { LivePayload, MarketSnapshotView, OpenPositionView } from '@/lib/live/types'
import type { CoinInfo } from '@/lib/queries/monedas'
import { position } from '../fixtures'
import { livePayload, NOW } from '../nav/fixtures'

const MINUTE = 60_000

/** El θ vigente de la cartera real (`learning.params.theta`). */
export const THETA = 0.35

// Las 30 del tablero en el orden del snapshot (el del universo): símbolo, cambio de
// 24 h y S′ del último ciclo. SHIB no tiene puntaje: queda al final.
const BOARD: readonly [string, number | null, number | null][] = [
  ['BTCUSDT', 0.012, 0.18],
  ['ETHUSDT', -0.009, 0.38],
  ['SOLUSDT', 0.041, 0.6],
  ['BNBUSDT', 0.004, -0.05],
  ['XRPUSDT', -0.015, -0.22],
  ['DOGEUSDT', 0.023, 0.12],
  ['ADAUSDT', -0.006, 0.08],
  ['AVAXUSDT', 0.002, -0.36],
  ['LINKUSDT', 0.019, 0.26],
  ['DOTUSDT', -0.002, -0.03],
  ['LTCUSDT', -0.011, -0.15],
  ['NEARUSDT', 0.034, 0.39],
  ['APTUSDT', -0.022, -0.29],
  ['ARBUSDT', 0.01, 0.4],
  ['OPUSDT', 0.007, -0.37],
  ['SUIUSDT', 0.052, 0.31],
  ['INJUSDT', -0.03, -0.48],
  ['FILUSDT', -0.004, -0.41],
  ['UNIUSDT', 0.014, 0.1],
  ['AAVEUSDT', 0.021, 0.2],
  ['WIFUSDT', 0.068, 0.44],
  ['1000PEPEUSDT', 0.039, 0.72],
  ['TONUSDT', 0.001, 0.02],
  ['FETUSDT', -0.026, -0.33],
  ['ATOMUSDT', 0.003, 0.05],
  ['ETCUSDT', -0.008, -0.11],
  ['HBARUSDT', 0.006, 0.07],
  ['TRXUSDT', 0, 0.45],
  ['BCHUSDT', -0.012, -0.19],
  ['1000SHIBUSDT', 0.009, null],
]

/** El orden que tiene que mostrar el tablero: abiertas por |S′|, después el resto por |S′|. */
export const EXPECTED_ORDER = [
  'SOL', 'ETH', 'AVAX',
  'PEPE', 'INJ', 'TRX', 'WIF', 'FIL', 'ARB', 'NEAR', 'OP', 'FET', 'SUI', 'APT', 'LINK', 'XRP',
  'AAVE', 'BCH', 'BTC', 'LTC', 'DOGE', 'ETC', 'UNI', 'ADA', 'HBAR',
  // Empate en |S′| = 0,05: queda el orden del snapshot.
  'BNB', 'ATOM',
  'DOT', 'TON', 'SHIB',
]

/** WIF vuelve de la penitencia el 7 de noviembre a las 12:00 de Buenos Aires. */
export const WIF_BACK = Date.UTC(2026, 10, 7, 15, 0)

function view(symbol: string, change24h: number | null, sPrime: number | null): MarketSymbolView {
  const base: MarketSymbolView = { symbol, markPrice: 10, change24h, sPrime, lean: sPrime === null ? 0 : sPrime / THETA, state: 'ready' }
  switch (symbol) {
    case 'SOLUSDT':
    case 'ETHUSDT':
    case 'AVAXUSDT':
      return { ...base, state: 'in_position' }
    case 'FILUSDT':
      return { ...base, state: 'degraded', staleSince: new Date(NOW - 3 * MINUTE).toISOString() }
    case 'NEARUSDT':
      return { ...base, state: 'cooldown', stateUntil: new Date(NOW + 45 * MINUTE).toISOString() }
    case 'WIFUSDT':
      return { ...base, state: 'penalized', stateUntil: new Date(WIF_BACK).toISOString() }
    default:
      return base
  }
}

export function market(patch: (symbols: MarketSymbolView[]) => MarketSymbolView[] = (s) => s): MarketSnapshotView {
  return { version: 7, updatedAt: NOW - 5_000, symbols: patch(BOARD.map(([s, c, p]) => view(s, c, p))) }
}

export function openPosition(id: string, patch: Partial<Position>, net: number): OpenPositionView {
  const p = position(id, patch)
  return {
    ...p,
    sessionId: 'ses_live',
    missingSignals: [],
    latencyMs: null,
    valuation: { mark: p.entryPrice, unrealized: net, net, r: net / p.riesgoReal, pctOfMargin: net / p.margin },
  }
}

export const OPEN: OpenPositionView[] = [
  openPosition('p-sol', { symbol: 'SOLUSDT', side: 'long', leverage: 5, entryPrice: 142.1, openedAt: NOW - 3 * 3_600_000 }, 12.4),
  openPosition('p-eth', { symbol: 'ETHUSDT', side: 'long', leverage: 3 }, 4.2),
  openPosition('p-avax', { symbol: 'AVAXUSDT', side: 'short', leverage: 2 }, -3.1),
]

export function settingsWith(universe: Partial<Settings['universe']>): Settings {
  return { ...DEFAULT_SETTINGS, universe: { ...DEFAULT_SETTINGS.universe, ...universe } }
}

export function boardLive(patch: Partial<LivePayload> = {}): LivePayload {
  return livePayload({ market: market(), open: OPEN, settingsVersion: 4, ...patch })
}

const UNIT_WEIGHTS = Object.fromEntries(SIGNAL_IDS.map((id) => [id, 1])) as Record<SignalId, number>

export function coinInfo(symbol: string, patch: Partial<CoinInfo> = {}): CoinInfo {
  return {
    symbol,
    name: symbol.replace(/^1000/, '').replace(/USDT$/, ''),
    decision: {
      at: NOW - 2 * MINUTE,
      S: 0.5,
      Sprime: 0.6,
      signals: [
        { id: 'trend15m', value: 0.8 },
        { id: 'trendHigher', value: 0.5 },
        { id: 'momentum', value: -0.3 },
        { id: 'funding', value: null },
      ],
      missingSignals: ['funding'],
      action: 'wait',
      blockedBy: null,
    },
    weights: { ...UNIT_WEIGHTS, trend15m: 1.4 },
    confidence: 0,
    multiplier: 1,
    learnedTrades: 0,
    penaltyUntil: null,
    stats: null,
    pinned: false,
    excluded: false,
    ...patch,
  }
}

export function boardCoins(): Record<string, CoinInfo> {
  const coins: Record<string, CoinInfo> = {}
  for (const [symbol] of BOARD) coins[symbol] = coinInfo(symbol)
  coins.SOLUSDT = coinInfo('SOLUSDT', {
    confidence: 0.3,
    learnedTrades: 3,
    stats: { trades: 6, wins: 4, pnlNet: 31.2, winRate: 4 / 6 },
  })
  coins.WIFUSDT = coinInfo('WIFUSDT', {
    confidence: -0.45,
    multiplier: 0.55,
    learnedTrades: 8,
    penaltyUntil: WIF_BACK,
    decision: { ...coinInfo('WIFUSDT').decision!, Sprime: 0.44, action: 'blocked:penalty', blockedBy: 'penalty' },
  })
  return coins
}
