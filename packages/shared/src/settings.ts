import { z } from 'zod'

// Configuración completa de una sesión en vivo. Se guarda validada en la tabla
// `settings` (una fila por sesión, con `version` para optimistic locking) y es el
// contrato entre el dashboard (que la edita) y el bot (que la aplica).
export const SettingsSchema = z.object({
  mode: z.enum(['auto', 'custom']),
  capital: z.object({
    protectPct: z.number().min(0).max(1),
    reinvest: z.boolean(),
    onShield: z.enum(['keep', 'reduce', 'closeAll']),
  }),
  risk: z.object({
    riskPerTrade: z.number().positive().max(0.05),
    maxLeverage: z.number().int().min(1).max(20),
    maxPositions: z.number().int().min(1).max(20),
    maxSameDirection: z.number().int().min(1),
    maxMarginPerTrade: z.number().positive().max(1),
    maxMarginInUse: z.number().positive().max(1),
    maxNotionalMultiple: z.number().positive(),
    dailyLossLimit: z.number().positive().max(1),
    maxDrawdown: z.number().positive().max(1),
    maxConsecutiveStops: z.number().int().min(1),
    streakPauseHours: z.number().positive(),
    takerFeeRate: z.number().min(0),
    makerFeeRate: z.number().min(0),
    slippageRate: z.number().min(0),
    mmrBySymbol: z.record(z.string(), z.number()),
    mmrDefault: z.number(),
    // Fracción del capital inicial que la sesión puede perder antes de cerrar todo y
    // apagarse (piso = capitalInicial × (1 − lossCap)). 1 = apagado: papel y replay;
    // el default completa los ajustes guardados antes de que existiera.
    lossCap: z.number().min(0.1).max(1).default(1),
  }),
  exits: z.object({
    k: z.number().positive(),
    tpR: z.number().positive(),
    trailingR: z.number().positive(),
    trailingActivationR: z.number().positive(),
    timeExitHours: z.number().positive(),
    timeExitMinR: z.number(),
    signalExitFraction: z.number().min(0).max(1),
    stopFloorCostMultiple: z.number().positive(),
  }),
  entry: z.object({
    theta: z.number().min(0.1).max(0.9),
    minRelVolume: z.number().min(0),
    cooldownCandlesAfterLoss: z.number().int().min(0),
    globalCooldownCandles: z.number().int().min(0),
    globalCooldownStopsPerHour: z.number().int().min(1),
    decisionDeadlineMs: z.number().int().min(0),
  }),
  custom: z.object({
    marginPerTrade: z.object({ kind: z.enum(['usd', 'pct']), value: z.number().positive() }),
    leverage: z.number().int().min(1).max(20),
    tpPct: z.number().positive(),
    slPct: z.number().positive(),
    trailingPct: z.number().positive().nullable(),
    maxPositions: z.number().int().min(1),
    direction: z.enum(['both', 'long', 'short']),
  }),
  universe: z.object({
    topN: z.number().int().min(1).max(100),
    pinned: z.array(z.string()),
    excluded: z.array(z.string()),
    includeTradFi: z.boolean(),
    minHistoryDays: z.number().int().min(0),
  }),
  learning: z.object({
    frozen: z.boolean(),
    weightLearningMinTrades: z.number().int(),
    eta: z.number().positive(),
    weeklyCap: z.number().positive(),
    shrinkageK: z.number().positive(),
    confidenceAlpha: z.number().positive().max(1),
    penaltyThreshold: z.number(),
    penaltyMinTrades: z.number().int(),
    penaltyDays: z.number().int(),
    paramTuningEnabled: z.boolean(),
  }),
  pause: z.object({
    paused: z.boolean(),
    by: z.enum(['user', 'auto']).nullable(),
    at: z.string().nullable(),
    reason: z.string().nullable(),
  }),
})

export type Settings = z.infer<typeof SettingsSchema>

// Valores por defecto del documento de diseño (spec §5, §7 y §8). También son la
// configuración de la "sombra": el motor que corre en paralelo sin aprendizaje.
export const DEFAULT_SETTINGS: Settings = {
  mode: 'auto',
  capital: { protectPct: 0.7, reinvest: true, onShield: 'reduce' },
  risk: {
    riskPerTrade: 0.01,
    maxLeverage: 5,
    maxPositions: 5,
    maxSameDirection: 3,
    maxMarginPerTrade: 0.2,
    maxMarginInUse: 0.6,
    maxNotionalMultiple: 3,
    dailyLossLimit: 0.03,
    maxDrawdown: 0.15,
    maxConsecutiveStops: 6,
    streakPauseHours: 4,
    takerFeeRate: 0.0005,
    makerFeeRate: 0.0002,
    slippageRate: 0.0002,
    mmrBySymbol: { BTCUSDT: 0.004, ETHUSDT: 0.005 },
    mmrDefault: 0.02,
    lossCap: 1,
  },
  exits: {
    // k 2 y theta 0,55: el banco de 180 días (research-report.md) los eligió por reducir daño,
    // no por ventaja probada: un tercio de los trades y la mitad del drawdown.
    k: 2,
    tpR: 2,
    trailingR: 1,
    trailingActivationR: 1,
    timeExitHours: 48,
    timeExitMinR: 0.3,
    signalExitFraction: 0.5,
    stopFloorCostMultiple: 8,
  },
  entry: {
    theta: 0.55,
    minRelVolume: 0.8,
    cooldownCandlesAfterLoss: 4,
    globalCooldownCandles: 2,
    globalCooldownStopsPerHour: 3,
    decisionDeadlineMs: 3000,
  },
  custom: {
    marginPerTrade: { kind: 'pct', value: 0.1 },
    leverage: 5,
    tpPct: 0.04,
    slPct: 0.02,
    trailingPct: null,
    maxPositions: 5,
    direction: 'both',
  },
  universe: { topN: 30, pinned: [], excluded: [], includeTradFi: false, minHistoryDays: 60 },
  learning: {
    frozen: false,
    weightLearningMinTrades: 50,
    eta: 0.02,
    weeklyCap: 0.15,
    shrinkageK: 30,
    confidenceAlpha: 0.2,
    // La confianza es una EMA de r = clamp(R, −2, 2) / 2: una racha de stops a −1R
    // converge a −0,5 sin cruzarlo nunca. −0,4 lo cruza al 8º stop (−0,416).
    penaltyThreshold: -0.4,
    penaltyMinTrades: 8,
    penaltyDays: 7,
    paramTuningEnabled: true,
  },
  pause: { paused: false, by: null, at: null, reason: null },
}

// Autor (`settings_history.changed_by`) de las versiones que escribe el bot con el mmr y
// las comisiones de la cuenta de Binance (clave de sólo lectura): el dashboard muestra
// de ahí el origen de esos valores y el diario, el cambio.
export const ACCOUNT_TIERS_AUTHOR = 'bot:tiers'
// Lo que dice el diario de esa versión (y el log del bot al guardarla).
export const ACCOUNT_TIERS_PHRASE = 'Actualicé los márgenes de mantenimiento y las comisiones con los de tu cuenta de Binance.'

type Risk = Settings['risk']
/** Lo que el job `accountTiers` trae de la cuenta de Binance. */
export type AccountTiersFields = Pick<Risk, 'mmrBySymbol' | 'takerFeeRate' | 'makerFeeRate'>

/** Mismo mmr por moneda, sin importar el orden de las claves (jsonb las guarda ordenadas a su manera). */
export function sameMmrTable(a: Risk['mmrBySymbol'], b: Risk['mmrBySymbol']): boolean {
  const symbols = Object.keys(a)
  return symbols.length === Object.keys(b).length && symbols.every((symbol) => b[symbol] === a[symbol])
}

/** Mismo mmr y mismas comisiones: lo que guarda el bot de la cuenta coincide con lo que hay. */
export function sameAccountTiers(a: AccountTiersFields, b: AccountTiersFields): boolean {
  return a.takerFeeRate === b.takerFeeRate && a.makerFeeRate === b.makerFeeRate && sameMmrTable(a.mmrBySymbol, b.mmrBySymbol)
}
