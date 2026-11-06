# Sereno — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir Sereno: bot de futuros USDT-M de Binance con paper trading, replay histórico, aprendizaje explicable y dashboard web (desktop y celular), según el documento de diseño.

**Architecture:** Monorepo pnpm + Turborepo. `packages/core` es un motor puro (sin IO ni reloj) que recibe un `MarketView` fechado y devuelve decisiones, órdenes y eventos; `apps/bot` lo alimenta con Binance (REST + websocket `/market`) y persiste en Postgres (Neon en producción, Postgres local en desarrollo); `apps/web` (Next.js 16) lee la base y controla al bot a través de ella (`settings` con versión, `bot_commands` con claim atómico). Replay y vivo usan exactamente el mismo motor.

**Tech Stack:** TypeScript 5.9 (strict), Node 22, pnpm 12, Turborepo 2, Vitest 4, zod 4, Drizzle ORM 0.45 + drizzle-kit 0.31, `pg` 8 (bot, migraciones) y `@neondatabase/serverless` 1.2 (web), Next.js 16.4 + React 19.3, Tailwind CSS 4.3, Motion 14 (`motion/react`), TanStack Query 5, lightweight-charts 5, Better Auth 1.7 + `@better-auth/drizzle-adapter`, pino 10, `ws` 8, Playwright 1.64 (humo).

**Spec:** `docs/superpowers/specs/2026-10-31-sereno-trading-bot-design.md` (mockups aprobados en `docs/superpowers/specs/assets/2026-10-31-direccion-visual.html`).

## Global Constraints

- Sin IO ni `Date.now()` dentro de `packages/core`: el tiempo entra como parámetro (`t`, `clock()`), el azar como `rng()` con semilla.
- Regla de causalidad: una vela de marco M es visible en `t` sólo si `closeTime ≤ t`; datos de futuros sólo si `at ≤ t` (spec 5.2).
- Todos los multiplicadores de tamaño están en `(0, 1]`; un stop tocado pierde como máximo `riskPerTrade` (1%) de `capitalBase` (spec 5.5).
- Invariante de liquidación: `|liquidationPrice − entry| ≥ 3 × |stop − entry|`, si no, no se abre (spec 5.5).
- Puntaje compuesto sobre señales disponibles: `S = Σ_disp wᵢ·sᵢ / Σ_disp wᵢ` (spec 5.3).
- Orden canónico intra-vela en replay: apertura → gap → extremo adverso → extremo favorable → cierre (spec 6).
- Fórmula de liquidación Binance aislado tier 1: `long: entry × (1 − 1/L) / (1 − mmr)`, `short: entry × (1 + 1/L) / (1 + mmr)` (spec 6).
- Funding: `qty × markPrice(fundingTime) × rate` (spec 6). Comisión taker 0,05% sobre nocional al fill (spec 6).
- Blindaje: se dispara cuando `min(realizado, equity − baseBlindaje) ≥ protectPct × baseBlindaje` (spec 7).
- Pausa: no abre nuevas, sigue cuidando salidas (spec 7).
- Aprendizaje sólo reduce tamaño (`mMoneda ∈ [0,5; 1,0]`), pesos en `[0,2; 2,0]`, `η = 0,02`, congelado hasta 50 trades, tope ±0,15 por semana (spec 8).
- Websocket: una conexión a `wss://fstream.binance.com/market/stream`; nunca `/ws` ni `/stream` sin ruta (spec 3 y 12).
- Comandos: claim atómico `FOR UPDATE SKIP LOCKED`, `expiresAt` 60 s en `close_position`/`close_all`, idempotencia por uuid del cliente (spec 10).
- Copy en castellano rioplatense, voseo, oración (nunca mayúsculas), moneda `US$ 1.247,80`, signo menos U+2212, zona `America/Argentina/Buenos_Aires` sólo al formatear (spec 3 y 11.2).
- Tokens de color y tipografía Instrument Sans exactamente como spec 11.2; movimiento según spec 11.3; `prefers-reduced-motion` y `prefers-reduced-transparency` respetados.
- Vocabulario: "simulación"/"replay" para sesiones de trading; "cerrar sesión" sólo para la cuenta.
- El dashboard nunca llama a Binance. Sólo el bot.
- Commits chicos con mensajes en castellano estilo `feat(core): …`, terminados con `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. **Vela de 4h abierta en un cierre de 15m.** Al evaluar a las 10:15, el motor no debe ver la vela 08:00–12:00. Test en Task 4 (`market-view.test.ts`: "excluye velas con closeTime > t").
2. **Stop y take profit en la misma vela de replay con trailing pendiente.** El adverso se evalúa antes que el favorable; el trailing no se mueve con el máximo antes de chequear el mínimo. Test en Task 13 (`intra-candle.test.ts`).
3. **Blindaje con no realizado negativo.** Realizado 70 pero abiertas −60: no se blinda. Test en Task 8 (`account.test.ts`: "no dispara si equity − base < umbral").
4. **Comando de cierre vencido ejecutado horas después.** Un `close_position` con `expiresAt` pasado debe quedar `expired`, nunca ejecutarse. Test en Task 20 (`commands.test.ts`).
5. **Bot sin conexión mostrando números "en vivo".** Con latido > 60 s el Resumen muestra la banda, apaga los números y deshabilita acciones. Test en Task 27 (`resumen.test.tsx`: "sin conexión").

---

## Estructura de archivos

```
package.json · pnpm-workspace.yaml · turbo.json · tsconfig.base.json · .env.example · vitest.workspace.ts
packages/shared/src/{index,types,settings,commands,money,time}.ts
packages/core/src/
  types.ts                         contratos del motor (Task 1)
  indicators/{ema,sma,rsi,macd,atr,adx,bollinger,donchian,vwap}.ts (Task 3)
  market/{candle-series,market-view}.ts (Task 4)
  universe/select-universe.ts (Task 5)
  signals/{trend-15m,trend-higher,momentum,breakout,bands,vwap,funding,open-interest,positioning,btc-regime,composite,modifiers,filters}.ts (Task 6)
  risk/{costs,liquidation,sizing,account-rules}.ts (Task 7)
  capital/account.ts (Task 8)
  exchange/{types,fills,paper-exchange,binance-exchange}.ts (Task 9)
  stats/{stats,verdict}.ts (Task 10)
  journal/phrases.ts (Task 11)
  engine/{engine,exits,position-manager,events}.ts (Task 12)
  replay/{intra-candle,replay-runner,clock}.ts (Task 13)
  learning/{weights,confidence,reliability,params,shadow,state}.ts (Task 14)
  index.ts (Task 15)
packages/db/src/{client,schema/*,repos/*}.ts · drizzle.config.ts · migrations/ · scripts/{migrate,seed-user}.ts (Tasks 16–17)
apps/bot/src/{index,config,logger}.ts · binance/{rest,rate-limiter,ws,types,fake}.ts · live/{runtime,scheduler,lease,commands,heartbeat,warmup,persist}.ts · replay/{download,run,worker}.ts · jobs/{universe,futures-data,forward-returns,param-tuning,cleanup}.ts · Dockerfile (Tasks 18–22)
apps/web/ · app/… · components/… · lib/… · proxy.ts · public/manifest.webmanifest (Tasks 23–33)
```

---

### Task 1: Scaffold del monorepo y contratos compartidos

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `.npmrc`, `.env.example`, `vitest.workspace.ts`, `README.md`
- Create: `packages/shared/{package.json,tsconfig.json,src/index.ts,src/types.ts,src/settings.ts,src/commands.ts}`
- Create: `packages/core/{package.json,tsconfig.json,src/types.ts,src/index.ts}`
- Create: `packages/db/{package.json,tsconfig.json,src/index.ts}`, `apps/bot/{package.json,tsconfig.json,src/index.ts}`, `apps/web/{package.json,tsconfig.json,next.config.ts}` (esqueletos que compilan)
- Test: `packages/shared/test/settings.test.ts`

**Interfaces:**
- Produces: `SettingsSchema`, `Settings`, `DEFAULT_SETTINGS`, `CommandSchema`, `Command` en `@sereno/shared`; todos los tipos del motor en `@sereno/core` `src/types.ts` (copiados abajo); scripts raíz `pnpm dev | build | test | lint | typecheck | bot | db:generate | db:migrate`.

- [ ] **Step 1: Crear el workspace** con `pnpm-workspace.yaml` (`apps/*`, `packages/*`), `turbo.json` (tasks `build` con `dependsOn: ["^build"]`, `test`, `lint`, `typecheck`, `dev` con `cache: false, persistent: true`; `globalEnv`: `DATABASE_URL, DATABASE_URL_UNPOOLED, BETTER_AUTH_SECRET, BETTER_AUTH_URL, ALLOWED_EMAILS, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, DASHBOARD_PASSWORD, LOG_LEVEL, BINANCE_API_KEY, BINANCE_API_SECRET`), `tsconfig.base.json` (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `module: NodeNext` para paquetes y bot, `moduleResolution: bundler` en web), versiones fijadas: typescript `^5.9.3`, vitest `^4.1.12`, turbo `^2.11.10`, tsx `^4.23.15`, zod `^4.6.7`. Paquetes con nombre `@sereno/shared`, `@sereno/core`, `@sereno/db`, `@sereno/bot`, `@sereno/web`, `"type": "module"`, exports desde `src` vía `tsx`/bundler (sin paso de build para paquetes internos: `"exports": { ".": "./src/index.ts" }`).
- [ ] **Step 2: Escribir el test de settings** en `packages/shared/test/settings.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { SettingsSchema, DEFAULT_SETTINGS } from '../src/settings'

describe('SettingsSchema', () => {
  it('acepta los valores por defecto', () => {
    expect(SettingsSchema.parse(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS)
  })
  it('tiene los defaults del documento', () => {
    expect(DEFAULT_SETTINGS.capital.protectPct).toBe(0.7)
    expect(DEFAULT_SETTINGS.risk.riskPerTrade).toBe(0.01)
    expect(DEFAULT_SETTINGS.risk.maxLeverage).toBe(5)
    expect(DEFAULT_SETTINGS.exits).toMatchObject({ k: 1.5, tpR: 2, trailingR: 1, trailingActivationR: 1, timeExitHours: 48, timeExitMinR: 0.3, stopFloorCostMultiple: 8 })
    expect(DEFAULT_SETTINGS.entry.theta).toBe(0.35)
    expect(DEFAULT_SETTINGS.risk.dailyLossLimit).toBe(0.03)
    expect(DEFAULT_SETTINGS.risk.maxDrawdown).toBe(0.15)
  })
  it('rechaza apalancamiento custom fuera de 1..20', () => {
    expect(() => SettingsSchema.parse({ ...DEFAULT_SETTINGS, custom: { ...DEFAULT_SETTINGS.custom, leverage: 50 } })).toThrow()
  })
  it('rechaza protectPct fuera de 0..1', () => {
    expect(() => SettingsSchema.parse({ ...DEFAULT_SETTINGS, capital: { ...DEFAULT_SETTINGS.capital, protectPct: 1.5 } })).toThrow()
  })
})
```

- [ ] **Step 3: Correr el test y verificar que falla** — `pnpm --filter @sereno/shared test` → FAIL (módulo inexistente).
- [ ] **Step 4: Implementar `packages/shared/src/settings.ts`** con zod 4:

```ts
export const SettingsSchema = z.object({
  mode: z.enum(['auto', 'custom']),
  capital: z.object({ protectPct: z.number().min(0).max(1), reinvest: z.boolean(), onShield: z.enum(['keep', 'reduce', 'closeAll']) }),
  risk: z.object({ riskPerTrade: z.number().positive().max(0.05), maxLeverage: z.number().int().min(1).max(20), maxPositions: z.number().int().min(1).max(20), maxSameDirection: z.number().int().min(1), maxMarginPerTrade: z.number().positive().max(1), maxMarginInUse: z.number().positive().max(1), maxNotionalMultiple: z.number().positive(), dailyLossLimit: z.number().positive().max(1), maxDrawdown: z.number().positive().max(1), maxConsecutiveStops: z.number().int().min(1), streakPauseHours: z.number().positive(), takerFeeRate: z.number().min(0), makerFeeRate: z.number().min(0), slippageRate: z.number().min(0), mmrBySymbol: z.record(z.string(), z.number()), mmrDefault: z.number() }),
  exits: z.object({ k: z.number().positive(), tpR: z.number().positive(), trailingR: z.number().positive(), trailingActivationR: z.number().positive(), timeExitHours: z.number().positive(), timeExitMinR: z.number(), signalExitFraction: z.number().min(0).max(1), stopFloorCostMultiple: z.number().positive() }),
  entry: z.object({ theta: z.number().min(0.1).max(0.9), minRelVolume: z.number().min(0), cooldownCandlesAfterLoss: z.number().int().min(0), globalCooldownCandles: z.number().int().min(0), globalCooldownStopsPerHour: z.number().int().min(1), decisionDeadlineMs: z.number().int().min(0) }),
  custom: z.object({ marginPerTrade: z.object({ kind: z.enum(['usd', 'pct']), value: z.number().positive() }), leverage: z.number().int().min(1).max(20), tpPct: z.number().positive(), slPct: z.number().positive(), trailingPct: z.number().positive().nullable(), maxPositions: z.number().int().min(1), direction: z.enum(['both', 'long', 'short']) }),
  universe: z.object({ topN: z.number().int().min(1).max(100), pinned: z.array(z.string()), excluded: z.array(z.string()), includeTradFi: z.boolean(), minHistoryDays: z.number().int().min(0) }),
  learning: z.object({ frozen: z.boolean(), weightLearningMinTrades: z.number().int(), eta: z.number().positive(), weeklyCap: z.number().positive(), shrinkageK: z.number().positive(), confidenceAlpha: z.number().positive().max(1), penaltyThreshold: z.number(), penaltyMinTrades: z.number().int(), penaltyDays: z.number().int(), paramTuningEnabled: z.boolean() }),
  pause: z.object({ paused: z.boolean(), by: z.enum(['user', 'auto']).nullable(), at: z.string().nullable(), reason: z.string().nullable() }),
})
export type Settings = z.infer<typeof SettingsSchema>
export const DEFAULT_SETTINGS: Settings = { mode: 'auto', capital: { protectPct: 0.7, reinvest: true, onShield: 'reduce' }, risk: { riskPerTrade: 0.01, maxLeverage: 5, maxPositions: 5, maxSameDirection: 3, maxMarginPerTrade: 0.2, maxMarginInUse: 0.6, maxNotionalMultiple: 3, dailyLossLimit: 0.03, maxDrawdown: 0.15, maxConsecutiveStops: 6, streakPauseHours: 4, takerFeeRate: 0.0005, makerFeeRate: 0.0002, slippageRate: 0.0002, mmrBySymbol: { BTCUSDT: 0.004, ETHUSDT: 0.005 }, mmrDefault: 0.02 }, exits: { k: 1.5, tpR: 2, trailingR: 1, trailingActivationR: 1, timeExitHours: 48, timeExitMinR: 0.3, signalExitFraction: 0.5, stopFloorCostMultiple: 8 }, entry: { theta: 0.35, minRelVolume: 0.8, cooldownCandlesAfterLoss: 4, globalCooldownCandles: 2, globalCooldownStopsPerHour: 3, decisionDeadlineMs: 3000 }, custom: { marginPerTrade: { kind: 'pct', value: 0.1 }, leverage: 5, tpPct: 0.04, slPct: 0.02, trailingPct: null, maxPositions: 5, direction: 'both' }, universe: { topN: 30, pinned: [], excluded: [], includeTradFi: false, minHistoryDays: 60 }, learning: { frozen: false, weightLearningMinTrades: 50, eta: 0.02, weeklyCap: 0.15, shrinkageK: 30, confidenceAlpha: 0.2, penaltyThreshold: -0.5, penaltyMinTrades: 8, penaltyDays: 7, paramTuningEnabled: true }, pause: { paused: false, by: null, at: null, reason: null } }
```

Y `packages/shared/src/commands.ts`: `CommandKind = 'close_position' | 'close_all' | 'run_replay' | 'cancel_replay' | 'release_protected' | 'reset_learning'`, `CommandSchema` con `id: uuid`, `sessionId`, `kind`, `payload` (discriminado por kind: `close_position` lleva `{ symbol }`, `run_replay` lleva `{ days, capital, learningOrigin: 'zero'|'current', paramTuning: boolean }`), `requestedBy: email`. `PRICE_SENSITIVE_COMMANDS = ['close_position', 'close_all']` con `COMMAND_TTL_MS = 60_000`.

- [ ] **Step 5: Escribir `packages/core/src/types.ts`** (contrato para todas las tareas de core; copiarlo tal cual y extenderlo sólo agregando campos opcionales):

```ts
export type Side = 'long' | 'short'
export type Timeframe = '15m' | '1h' | '4h' | '1d'
export type PriceType = 'last' | 'mark'
export interface Candle { openTime: number; closeTime: number; open: number; high: number; low: number; close: number; volume: number; quoteVolume: number; closed: boolean }
export interface SymbolInfo { symbol: string; baseAsset: string; minNotional: number; minQty: number; stepSize: number; tickSize: number; quantityPrecision: number; mmr: number; liquidationFee: number; fundingIntervalHours: number; halfSpreadRate: number; underlyingType: string; underlyingSubType: string[]; onboardDate: number }
export interface FuturesSnapshot { at: number; fundingRate: number | null; nextFundingTime: number | null; openInterest: number | null; openInterest1hAgo: number | null; openInterest4hAgo: number | null; longShortRatio: number | null; takerRatio: number | null }
export interface BtcContext { candles4h: Candle[]; realizedVol24h: number | null; realizedVol30dMean: number | null }
export interface MarketView { t: number; symbol: string; info: SymbolInfo; candles: Record<'15m' | '1h' | '4h', Candle[]>; futures: FuturesSnapshot | null; btc: BtcContext; markPrice: number; lastPrice: number }
export type SignalId = 'trend15m' | 'trendHigher' | 'momentum' | 'breakout' | 'bands' | 'vwap' | 'funding' | 'openInterest' | 'positioning' | 'btcRegime'
export const SIGNAL_IDS: readonly SignalId[]
export interface SignalResult { id: SignalId; value: number | null; detail?: Record<string, number> }
export interface Composite { S: number; Sprime: number; confidence: number; signals: SignalResult[]; missing: SignalId[]; weights: Record<SignalId, number>; modifiers: { adx: number; vol: number }; relVolume: number; higherTrendAgainst: 0 | 1 | 2 }
export type BlockReason = 'higher_trend_against' | 'low_volume' | 'has_position' | 'cooldown' | 'penalty' | 'degraded' | 'max_positions' | 'max_same_direction' | 'max_margin' | 'max_notional' | 'insufficient_capital' | 'daily_loss' | 'drawdown_pause' | 'streak_pause' | 'paused' | 'below_min_notional' | 'stop_too_small_for_cost' | 'liquidation_too_close' | 'risk_rounding' | 'direction_not_allowed' | 'no_candle'
export interface EntryPlan { side: Side; price: number; distanciaStop: number; riesgoUsd: number; riesgoReal: number; leverage: number; margin: number; notional: number; qty: number; stopPrice: number; takeProfitPrice: number | null; liquidationPrice: number; multipliers: { confidence: number; symbol: number; btc: number }; theta: number }
export type DecisionAction = { kind: 'enter'; plan: EntryPlan } | { kind: 'wait' } | { kind: 'blocked'; reason: BlockReason; wantedSide: Side | null }
export interface Decision { t: number; symbol: string; composite: Composite; action: DecisionAction; shadow?: { Sprime: number; action: DecisionAction['kind'] } }
export type CloseReason = 'stop' | 'take_profit' | 'trailing_stop' | 'signal_flip' | 'time_exit' | 'liquidation' | 'manual' | 'close_all' | 'shield_reduce' | 'delisted' | 'stop_missed_offline' | 'session_archived'
export interface Position { id: string; symbol: string; side: Side; leverage: number; margin: number; notional: number; qty: number; entryPrice: number; openedAt: number; stopPrice: number; takeProfitPrice: number | null; liquidationPrice: number; distanciaStop: number; riesgoReal: number; thetaAtOpen: number; trailingActive: boolean; bestPrice: number; stopOrderId: string | null; tpOrderId: string | null; feesPaid: number; fundingPaid: number; shadow: boolean; openReason: string; signalsAtOpen: SignalResult[]; mode: 'auto' | 'custom' }
export interface ClosedPosition extends Position { closedAt: number; exitPrice: number; closeReason: CloseReason; pnlGross: number; pnlNet: number; rMultiple: number; costs: { fees: number; spread: number; slippage: number; funding: number } }
export interface Fill { symbol: string; side: 'buy' | 'sell'; price: number; qty: number; fee: number; at: number; spreadCost: number; slippageCost: number }
export interface MarkTick { symbol: string; markPrice: number; lastPrice: number; at: number; fundingRate: number | null; nextFundingTime: number | null }
export interface FundingEvent { symbol: string; at: number; rate: number; markPrice: number }
export interface AccountSnapshot { capitalInicial: number; saldo: number; equity: number; protegido: number; baseBlindaje: number; capitalBase: number; capitalOperable: number; margenEnUso: number; realizado: number; unrealized: number; reinvest: boolean }
export interface LearningState { weightsGlobal: Record<SignalId, number>; weightsBySymbol: Record<string, Partial<Record<SignalId, number>>>; weeklyDelta: Record<SignalId, number>; weekStart: number; confidenceBySymbol: Record<string, number>; tradesBySymbol: Record<string, number>; penalties: Record<string, number>; params: { theta: number; k: number; tpR: number; trailingR: number; since: number }; frozen: boolean; closedTrades: number; version: number }
export type EngineEvent =
  | { type: 'decisions'; t: number; decisions: Decision[] }
  | { type: 'position_opened'; position: Position; fill: Fill; phrase: string }
  | { type: 'position_closed'; position: ClosedPosition; fill: Fill; phrase: string }
  | { type: 'stop_moved'; positionId: string; from: number; to: number; at: number; phrase: string }
  | { type: 'funding_applied'; positionId: string; amount: number; at: number }
  | { type: 'learning_updated'; at: number; message: string; sampleSize: number; before: unknown; after: unknown }
  | { type: 'account_rule'; at: number; rule: 'daily_loss' | 'drawdown' | 'streak' | 'shield' | 'shield_insufficient'; phrase: string; data?: unknown }
  | { type: 'waited'; t: number; symbol: string; reason: BlockReason; phrase: string }
```

- [ ] **Step 6: Correr los tests** — `pnpm test` en raíz → PASS (sólo shared tiene tests). `pnpm typecheck` → PASS en todos los paquetes esqueleto.
- [ ] **Step 7: Escribir `.env.example`** con todas las variables de `turbo.json` y comentarios, y `README.md` con los comandos (`pnpm dev`, `pnpm bot`, `pnpm bot replay --days 90`, `pnpm db:migrate`).
- [ ] **Step 8: Commit** — `chore: scaffold del monorepo y contratos compartidos`.

---

### Task 2: Formato es-AR y helpers de tiempo (`@sereno/shared`)

**Files:**
- Create: `packages/shared/src/money.ts`, `packages/shared/src/time.ts`
- Test: `packages/shared/test/money.test.ts`, `packages/shared/test/time.test.ts`

**Interfaces:**
- Produces: `formatUsd(n: number, opts?: { sign?: boolean; compact?: boolean }): string` → `"US$ 1.247,80"`, `"+US$ 38,20"`, `"−US$ 3,10"`; `formatNumber(n, decimals?)` → `"1.247,80"`; `formatPct(n: number, decimals = 1, sign = true)` → `"+24,8%"`; `formatSigned(n, decimals)` → `"−3,10"` (U+2212); `MINUS = '−'`. `time.ts`: `BA_TZ = 'America/Argentina/Buenos_Aires'`, `startOfDayBA(at: number): number`, `formatTimeBA(at)` → `"14:32"`, `formatDateBA(at)` → `"14 de octubre"`, `sinceLabel(startedAt: number, now: number): string` → `"hoy a las 10:15"` / `"ayer"` / `"el 14 de octubre"`, `relativeAge(at, now)` → `"hace 3 h"` / `"hace 20 min"` / `"hace 2 días"`.

- [ ] **Step 1: Tests** con valores exactos: `formatUsd(1247.8)` = `"US$ 1.247,80"`; `formatUsd(-3.1, { sign: true })` = `"−US$ 3,10"`; `formatUsd(38.2, { sign: true })` = `"+US$ 38,20"`; `formatPct(0.248)` = `"+24,8%"`; `formatPct(-0.009)` = `"−0,9%"`; `startOfDayBA(Date.UTC(2026,9,31,2,30))` = `Date.UTC(2026,9,30,3,0)` (00:00 BA del 30 de octubre, UTC−3); `sinceLabel(Date.UTC(2026,9,31,13,15), Date.UTC(2026,9,31,18,0))` = `"hoy a las 10:15"`; `sinceLabel(Date.UTC(2026,9,30,13,15), Date.UTC(2026,9,31,18,0))` = `"ayer"`; `sinceLabel(Date.UTC(2026,9,14,13,0), Date.UTC(2026,9,31,18,0))` = `"el 14 de octubre"`; `relativeAge(now − 3*3600e3, now)` = `"hace 3 h"`.
- [ ] **Step 2: Correr y ver fallar.**
- [ ] **Step 3: Implementar** con `Intl.NumberFormat('es-AR')` y `Intl.DateTimeFormat` con `timeZone: BA_TZ`; reemplazar el guion de `Intl` por U+2212; sin dependencias nuevas.
- [ ] **Step 4: Correr y ver pasar. Commit** — `feat(shared): formato es-AR y helpers de tiempo`.

---

### Task 3: Indicadores (`@sereno/core`)

**Files:**
- Create: `packages/core/src/indicators/{ema,sma,rsi,macd,atr,adx,bollinger,donchian,vwap,realized-vol}.ts`
- Test: `packages/core/test/indicators/*.test.ts`, fixtures en `packages/core/test/fixtures/indicators.json`

**Interfaces:**
- Produces: funciones puras sobre `number[]` o `Candle[]` que devuelven arrays alineados (NaN donde no hay dato): `ema(values, period)`, `sma(values, period)`, `rsi(closes, period = 14)` (Wilder), `macd(closes, 12, 26, 9)` → `{ macd, signal, histogram }`, `atr(candles, period = 14)` (Wilder), `adx(candles, period = 14)`, `bollinger(closes, 20, 2)` → `{ upper, middle, lower, pctB }`, `donchian(candles, 20)` → `{ upper, lower }` calculado **excluyendo la vela actual** (ventana `i-20..i-1`), `vwapDaily(candles, dayStartOf: (t) => number)` → `number[]` anclado al día UTC, `realizedVol(closes, window)` (desvío de log-retornos × √(velas por día)).

- [ ] **Step 1: Fixture** con 60 velas sintéticas deterministas (generadas con una fórmula fija documentada en el test, no aleatorias) y valores esperados calculados a mano para: `sma(…,5)` en índice 10, `ema(…,5)` en índice 10 (semilla = SMA de las primeras 5), `rsi` en una serie que sube 14 veces seguidas = 100, `atr` con velas de rango constante 2 = 2, `donchian` que en la vela 21 (cierre 110 sobre máximos previos 105) devuelve `upper[20] = 105` (no 110), `bollinger` de una serie constante = banda cero, `macd.histogram` de una serie constante = 0, `adx` de una tendencia perfectamente lineal > 25 después de 30 velas.
- [ ] **Step 2: Correr y ver fallar.**
- [ ] **Step 3: Implementar** cada indicador en su archivo, sin estado compartido.
- [ ] **Step 4: Correr y ver pasar. Commit** — `feat(core): indicadores técnicos`.

---

### Task 4: Series de velas y `MarketView` con causalidad

**Files:**
- Create: `packages/core/src/market/candle-series.ts`, `packages/core/src/market/market-view.ts`
- Test: `packages/core/test/market/market-view.test.ts`

**Interfaces:**
- Produces: `class CandleSeries { constructor(tf: Timeframe); upsert(c: Candle): void; closedUpTo(t: number, limit?: number): Candle[]; last(): Candle | undefined; }` (ordenada por `openTime`, única por `openTime`); `buildMarketView(input: { t: number; symbol: string; info: SymbolInfo; series: Record<'15m'|'1h'|'4h', CandleSeries>; futures: FuturesSnapshot[] (histórico ordenado); btc4h: CandleSeries; btc15m: CandleSeries; markPrice: number; lastPrice: number; warmup: { '15m': 300; '1h': 300; '4h': 300 } }): MarketView` que devuelve sólo velas con `closed && closeTime ≤ t`, el último `FuturesSnapshot` con `at ≤ t`, y `btc.realizedVol24h` / `realizedVol30dMean` desde `btc15m` (96 velas y media de los últimos 30 días de ventanas de 96).

- [ ] **Step 1: Tests**: (a) "excluye velas con closeTime > t": con una vela de 4h `openTime 08:00, closeTime 11:59:59.999` y `t = 10:15`, `view.candles['4h']` termina en la vela cerrada a las 07:59:59.999; (b) "excluye velas no cerradas aunque closeTime ≤ t"; (c) "futures toma el último snapshot ≤ t"; (d) "respeta el límite de calentamiento (300)"; (e) `CandleSeries.upsert` reemplaza la vela del mismo `openTime`.
- [ ] **Step 2–4:** fallar, implementar, pasar. **Commit** — `feat(core): MarketView con regla de causalidad`.

---

### Task 5: Selección de universo

**Files:**
- Create: `packages/core/src/universe/select-universe.ts`
- Test: `packages/core/test/universe/select-universe.test.ts`

**Interfaces:**
- Produces: `selectUniverse(input: { contracts: ContractMeta[]; volumes: Record<string, number>; today: number; settings: Settings['universe']; openSymbols: string[] }): { symbols: string[]; excludedByFilter: Record<string, string> }` donde `ContractMeta = { symbol, baseAsset, quoteAsset, contractType, status, underlyingType, underlyingSubType: string[], onboardDate }`. Reglas spec 5.1: `PERPETUAL`, `TRADING`, `USDT`, `COIN`, sin `TradFi` salvo `includeTradFi`, `baseAsset` fuera de `STABLECOINS = ['USDC','FDUSD','TUSD','USDP','DAI','USDE','BUSD','USD1','USDD']`, `onboardDate ≤ today − minHistoryDays`; luego `pinned` primero, `excluded` fuera, top `topN` por volumen; `openSymbols` se mantienen aunque salgan del top.

- [ ] **Step 1: Tests** con 40 contratos sintéticos: excluye `XAUUSDT` (COMMODITY/TradFi) salvo `includeTradFi`, excluye `USDCUSDT`, excluye un contrato con 30 días de historia, mantiene `SOLUSDT` abierto aunque caiga al puesto 35, respeta `pinned` y `excluded`, devuelve exactamente `topN`.
- [ ] **Step 2–4:** fallar, implementar, pasar. **Commit** — `feat(core): selección de universo`.

---

### Task 6: Señales, modificadores, filtros y puntaje compuesto

**Files:**
- Create: `packages/core/src/signals/{trend-15m,trend-higher,momentum,breakout,bands,vwap,funding,open-interest,positioning,btc-regime}.ts`, `packages/core/src/signals/composite.ts`, `packages/core/src/signals/modifiers.ts`, `packages/core/src/signals/filters.ts`, `packages/core/src/signals/index.ts`
- Test: `packages/core/test/signals/*.test.ts`

**Interfaces:**
- Consumes: Task 3 indicadores, Task 4 `MarketView`.
- Produces: cada señal `(view: MarketView) => SignalResult` (valor `null` si faltan datos; nunca lanza); `computeComposite(view, weights: Record<SignalId, number>): Composite` (spec 5.3: promedio ponderado sólo sobre disponibles, `missing`, `Sprime = S × mADX × mVol`, `relVolume` = volumen última vela 15m / media de 96, `higherTrendAgainst` = cuántos de {1h, 4h} están en contra del lado de `S`); `entryFilters(view, composite, ctx: { hasPosition; inCooldown; inPenalty; degraded; direction }): BlockReason | null` para los filtros booleanos de spec 5.3(c) y 5.4 (sin capacidad, que vive en Task 7).

- [ ] **Step 1: Tests por señal** con vistas sintéticas: `trend15m` = +1 cuando EMA20>EMA50>EMA200 y pendiente positiva; `breakout` = +1 cuando el cierre supera el máximo de las 20 previas y 0 cuando sólo iguala; `funding` = −0,5 para longs con `fundingRate = 0.0008` (contrarian: valor negativo); `openInterest` = +1 si precio y OI suben más de 1% en 4h; `btcRegime` = 0 para `BTCUSDT`; `momentum` resta en sobrecompra (RSI 80 con MACD positivo ⇒ valor < el mismo caso con RSI 60); cada señal devuelve `null` con `futures = null` cuando lo necesita.
- [ ] **Step 2: Tests de composite**: con 10 señales de peso 1 y 3 en `null`, `S` es el promedio de las 7 disponibles (no de 10); `missing` lista las 3; `mADX = 0.5` con ADX 15; `mVol = 1.2` con volumen relativo 3; `higherTrendAgainst = 2` cuando S > 0 y 1h y 4h bajistas.
- [ ] **Step 3: Tests de filtros**: `higher_trend_against` cuando ambos en contra; `low_volume` con relVolume 0,5; `has_position`; `cooldown`; `penalty`; `direction_not_allowed` con `direction: 'long'` y S < 0.
- [ ] **Step 4–6:** fallar, implementar, pasar. **Commit** — `feat(core): señales y puntaje compuesto`.

---

### Task 7: Costos, liquidación, tamaño y reglas de capacidad

**Files:**
- Create: `packages/core/src/risk/{costs,liquidation,sizing,account-rules}.ts`
- Test: `packages/core/test/risk/*.test.ts`

**Interfaces:**
- Produces: `roundTripCost(info: SymbolInfo, risk: Settings['risk']): number` = `2×taker + 2×halfSpread + 2×slippage`; `liquidationPrice(side, entry, leverage, mmr): number` (fórmula Binance aislado tier 1); `planEntry(input: { side; price; atr1h; info; capitalBase; capitalOperable; settings; multipliers: { confidence; symbol; btc } ; theta }): { ok: true; plan: EntryPlan } | { ok: false; reason: BlockReason }` (spec 5.5 con la secuencia exacta: piso de costo, riesgoUsd con multiplicadores, nocional, apalancamiento `clamp(floor(1/(3×d+mmr)),1,max)`, margen, tope 20% reduciendo nocional, `qty = floor(nocional/price, stepSize)`, mínimos, `riesgoReal`, rechazo si `riesgoReal > 1,5 × riesgoUsd`, invariante de liquidación, `takeProfitPrice = entry ± tpR × d × entry`, `stopPrice = entry ∓ d × entry`); `planCustomEntry(input)` para el modo custom (margen fijo, apalancamiento fijo, SL/TP en % de precio, `riesgoReal = nocional × slPct`); `checkCapacity(input: { open: Position[]; side; plan; capitalBase; capitalOperable; settings; mode }): BlockReason | null` (posiciones máximas, 3 por dirección, 60% margen, 3× nocional en auto; sólo `max_positions`, `max_same_direction`, `insufficient_capital` en custom); `accountRules(input: { capitalBase; todayRealized; equityPeak; equity; consecutiveStops; stopsLastHour; now; settings }): { blocked: BlockReason | null; flags: { dailyLossHit; drawdownPause; streakPauseUntil: number | null } }`.

- [ ] **Step 1: Tests de liquidación**: `liquidationPrice('long', 100, 5, 0.01)` ≈ `80.808` (= 100×0,8/0,99); `('short', 100, 5, 0.01)` ≈ `118.812`.
- [ ] **Step 2: Tests de tamaño** (valores del ejemplo del spec): `capitalBase 1000, price 100, atr1h 0.5 (0,5%), k 1,5, info BTC-like (minNotional 5, stepSize 0.001, mmr 0.01, halfSpread 0.0001), taker 0.0005, slippage 0.0002, multipliers 1` ⇒ `distanciaStop = max(0.0075, 8×0.0016=0.0128) = 0.0128`, `riesgoUsd = 10`, `nocionalObjetivo = 781.25`, `apalancamiento = clamp(floor(1/(0.0384+0.01)),1,5) = 5`, `margen = 156.25` (< 200), `qty = 7.812`, `riesgoReal ≈ 10.0`, `liquidación ≥ 3 stops` ✓. Caso de piso dominante: `atr1h 0.1` ⇒ `8×costo = 0.0128 > 2×0.0015` ⇒ `stop_too_small_for_cost`. Caso multiplicador 0,5 ⇒ `riesgoUsd 5`. Caso `minNotional 100` con capital 100 ⇒ `below_min_notional`. Caso step grueso (`stepSize 1`, price 60, nocional objetivo 40) ⇒ `risk_rounding` o `below_min_notional` según corresponda (documentar cuál en el test). Caso tope de margen: `atr1h 0.05` y `capitalBase 100` ⇒ margen > 20 ⇒ se reduce el nocional y el apalancamiento se mantiene.
- [ ] **Step 3: Tests de capacidad y reglas de cuenta**: 5 abiertas ⇒ `max_positions`; 3 longs ⇒ `max_same_direction` para un long, permitido para un short; margen en uso 590 + nuevo 20 sobre base 1000 ⇒ `max_margin`; pérdida del día −31 sobre base 1000 ⇒ `daily_loss`; equity 840 con pico 1000 ⇒ `drawdownPause`; 6 stops seguidos ⇒ `streakPauseUntil = now + 4h`.
- [ ] **Step 4–6:** fallar, implementar, pasar. **Commit** — `feat(core): tamaño, apalancamiento, liquidación y reglas de capacidad`.

---

### Task 8: Cuenta, blindaje y reinversión

**Files:**
- Create: `packages/core/src/capital/account.ts`
- Test: `packages/core/test/capital/account.test.ts`

**Interfaces:**
- Produces: `class Account { constructor(init: { capitalInicial: number; reinvest: boolean; protectPct: number; onShield: 'keep'|'reduce'|'closeAll' }); applyRealized(amount: number): void; snapshot(open: Position[], marks: Record<string, number>): AccountSnapshot; checkShield(open: Position[], marks): { triggered: boolean; toClose: Position[] }; releaseProtected(): void; setReinvest(v: boolean): void; marginInUse(open): number; }` con las reglas de spec 7: `capitalBase = saldo − protegido` (reinvest off ⇒ `min(…, baseBlindaje)`), `capitalOperable = max(0, capitalBase − margenEnUso)`, disparo con `min(realizado, equity − baseBlindaje) ≥ protectPct × baseBlindaje`, `toClose` ordenado por peor R vigente hasta que `Σ márgenes ≤ saldo − baseBlindaje` cuando `onShield = 'reduce'`, todas cuando `'closeAll'`, ninguna cuando `'keep'`; `releaseProtected` pone `protegido = 0` y `baseBlindaje = saldo`.

- [ ] **Step 1: Tests**: (a) con I₀ 100, p 0,7, realizado +70 y sin abiertas ⇒ `triggered`, `protegido = 100`, `capitalBase = 70`; (b) "no dispara si equity − base < umbral": realizado +70 pero abiertas −60 no realizado ⇒ `triggered = false`; (c) reduce: realizado +70, 5 abiertas con margen 20 cada una (100 > 70) ⇒ `toClose` tiene las 2 de peor R; (d) reinvest off: saldo 1.300, base 1.000 ⇒ `capitalBase = 1000`; (e) release: saldo 150 blindado 100 ⇒ `releaseProtected()` ⇒ `protegido 0`, `baseBlindaje 150`, nuevo disparo requiere realizado +105 desde ahí; (f) `capitalOperable` nunca negativo.
- [ ] **Step 2–4:** fallar, implementar, pasar. **Commit** — `feat(core): cuenta, blindaje y reinversión`.

---

### Task 9: Simulador de exchange con órdenes

**Files:**
- Create: `packages/core/src/exchange/{types,fills,paper-exchange,binance-exchange}.ts`
- Test: `packages/core/test/exchange/paper-exchange.test.ts`, `fills.test.ts`

**Interfaces:**
- Produces: la interfaz `Exchange` de spec 6 (con `MarketOrder = { symbol; side: 'buy'|'sell'; qty; reduceOnly?: boolean }`, `StopOrder = { symbol; side; stopPrice; closePosition: true }`, `Order = { id; symbol; type: 'STOP_MARKET'|'TAKE_PROFIT_MARKET'; side; stopPrice }`); `fillPrice(input: { lastPrice; halfSpreadRate; slippageRate; notional; side; adverseExtra?: number }): { price; spreadCost; slippageCost }` (slippage base + 0,01% por cada 10.000 de nocional; `adverseExtra` para stops = medio spread + 2 × slippage); `class PaperExchange implements Exchange { constructor(opts: { settings: Settings['risk']; infos: Record<string, SymbolInfo>; clock: () => number; initialBalance: number }); setPrices(symbol, { mark, last }): void; processTick(tick: MarkTick): TriggeredOrder[] /* dispara STOP/TP/liquidación por marca y los llena */; applyFunding(ev: FundingEvent): FundingApplied[]; }` con comisiones taker, funding `qty × mark × rate`, liquidación por fórmula de Task 7 y pérdida del margen completo.
- `BinanceFuturesExchange`: misma interfaz, cada método lanza `new Error('modo real deshabilitado')`.

- [ ] **Step 1: Tests**: apertura long 1 BTC a 100 (halfSpread 0,0001, slippage 0,0002) ⇒ `price = 100.03`, `fee = 0.05015`; cierre a 110 ⇒ `pnlGross ≈ 9.97`, dos comisiones; stop colocado en 95: tick con `mark 94.9` ⇒ dispara y llena a `last − (halfSpread + 2×slippage)` del last; TP y stop en la misma posición: dispara el primero que cruza; funding `rate 0.0001`, `qty 2`, `mark 101` ⇒ paga `0.0202` el long y cobra el short; liquidación: long 5x entrada 100 mmr 0,01 ⇒ tick mark 80 ⇒ cierre con pérdida = margen completo + fee, balance nunca negativo; `getOpenOrders` refleja cancelaciones; `BinanceFuturesExchange.placeMarketOrder` lanza.
- [ ] **Step 2–4:** fallar, implementar, pasar. **Commit** — `feat(core): simulador de exchange con órdenes de stop y take profit`.

---

### Task 10: Estadísticas y veredicto

**Files:**
- Create: `packages/core/src/stats/{stats,verdict}.ts`
- Test: `packages/core/test/stats/*.test.ts`

**Interfaces:**
- Produces: `computeStats(closed: ClosedPosition[], equity: { at: number; equity: number }[]): Stats` con `{ trades, wins, losses, winRate, profitFactor, expectancyR, avgWin, avgLoss, bestTrade, worstTrade, maxDrawdownPct, costs: { fees, spread, slippage, funding }, costPerRiskR, liquidations, bySymbol: Record<string, { trades; wins; pnlNet; winRate }> }`; `maxDrawdown(equitySeries): { pct; peakAt; troughAt }`; `verdict(closed: ClosedPosition[], days: number, opts: { minTrades: 100; minDays: 30; shadowGapPp?: number; rng: () => number }): { status: 'insufficient' | 'edge' | 'no_edge'; missingTrades?: number; expectancyR; ci95: [number, number]; profitFactor; maxDrawdownPct; reason: string }` con bootstrap de 2.000 remuestreos sobre `rMultiple` usando `rng` (determinista en tests con una semilla, por ejemplo mulberry32).

- [ ] **Step 1: Tests**: 3 trades (+2R, −1R, +1R) ⇒ `winRate 2/3`, `expectancyR 0.667`, `profitFactor = 3/1 = 3`; drawdown de la serie [100, 120, 90, 130] = 25% con pico 120; veredicto con 20 trades ⇒ `insufficient`, `missingTrades 80`; con 120 trades todos +0,5R ⇒ `edge`; con 120 trades alternando +1/−1 ⇒ `no_edge` y `reason` menciona que el intervalo incluye 0; mismo `rng` con semilla ⇒ mismo `ci95` en dos corridas.
- [ ] **Step 2–4:** fallar, implementar, pasar. **Commit** — `feat(core): estadísticas y veredicto`.

---

### Task 11: Frases del diario

**Files:**
- Create: `packages/core/src/journal/phrases.ts`
- Test: `packages/core/test/journal/phrases.test.ts`

**Interfaces:**
- Consumes: `formatUsd`, `formatPct` de `@sereno/shared`.
- Produces: `phraseOpen(p: Position, c: Composite): string`, `phraseClose(p: ClosedPosition): string`, `phraseStopMoved(p, from, to): string`, `phraseWait(symbol, reason: BlockReason, c): string`, `phraseLearning(change): string`, `phraseShield(...)`, `phraseLiquidation(p)`, `phraseAccountRule(rule, data)`, `headline(input: { total: number; realized: number; unrealized: number; sinceLabel: string; hasTrades: boolean; offline?: { at: string } }): string`, `capitalCard(input): { title; detail }`.

- [ ] **Step 1: Tests con frases exactas**: open ⇒ `"Abrí un long 5x en SOL con US$ 50. La tendencia en 1h y 4h acompaña y el funding está negativo."` (las razones se arman de las dos señales de mayor |valor×peso| con un diccionario fijo de frases por señal y signo; el test fija qué señales entran); close por TP ⇒ `"Cerré el long en SOL en el take profit: +US$ 12,40 (+2,0R)."`; liquidación ⇒ `"Me liquidaron el short en INJ: perdí los US$ 50 de margen."`; stop no ejecutado ⇒ `"Cerré el long en SOL al reconectar: el stop había quedado atrás mientras estaba sin conexión (−US$ 7,10)."`; wait ⇒ `"Miré SUI y esperé: la inclinación es fuerte pero el volumen no acompaña."`; headline casos: ganando, perdiendo, igual (`|total| < 0.01`), sin trades, signos distintos (`"Vas ganando US$ 195,70, aunque las abiertas van perdiendo US$ 52,10."`), offline (`"… con las abiertas valuadas a las 14:32."`).
- [ ] **Step 2–4:** fallar, implementar, pasar. **Commit** — `feat(core): frases del diario en castellano`.

---

### Task 12: Motor de trading (entradas, salidas, eventos)

**Files:**
- Create: `packages/core/src/engine/{engine,exits,position-manager,events}.ts`
- Test: `packages/core/test/engine/*.test.ts`

**Interfaces:**
- Consumes: Tasks 6–11.
- Produces: `class TradingEngine { constructor(deps: { exchange: Exchange; settings: Settings; learning: LearningState; account: Account; clock: () => number; sink: (e: EngineEvent) => void; shadow?: { exchange: Exchange; account: Account } }); onCandleClose(views: MarketView[], ctx: { missingSymbols: string[]; degraded: string[] }): CycleResult; onMarkTick(tick: MarkTick): void; onFunding(ev: FundingEvent): void; closePosition(symbol, reason: CloseReason): void; closeAll(reason): void; applySettings(s: Settings): void; applyLearning(l: LearningState): void; snapshot(): EngineSnapshot }`. `CycleResult = { decisions: Decision[]; opened: Position[]; closed: ClosedPosition[] }`. Orden del ciclo: (1) salidas por señal y por tiempo sobre abiertas, (2) reglas de cuenta y pausa, (3) candidatas ordenadas por confianza, filtros, capacidad, plan, orden a mercado + stop + TP en el exchange, (4) eventos. `onMarkTick`: pasa el tick al exchange (`processTick`), convierte órdenes disparadas en cierres, actualiza `bestPrice`, activa trailing a +1R moviendo el stop a entrada y luego a `trailingR × distanciaStop` del mejor precio (reemplazando la orden), y como respaldo cierra si la marca cruzó el stop y el exchange no lo disparó. `exits.ts`: `nextStop(p, mark, exits): number | null`, `shouldTimeExit(p, now, unrealizedR, exits)`, `shouldSignalExit(p, Sprime)`. En modo custom se usan `planCustomEntry` y salidas custom. La sombra decide con `DEFAULT_SETTINGS.entry/exits` y pesos 1,0 sobre su propio exchange/cuenta, sin `mMoneda`.

- [ ] **Step 1: Tests de ciclo**: con 3 vistas (S' = 0,6, 0,4, −0,5) y θ 0,35 ⇒ abre primero la de 0,6; con `maxPositions 2` la tercera queda `max_positions`; en pausa ⇒ todas `paused` pero un tick que cruza el stop cierra igual; salida por señal: posición long con `thetaAtOpen 0.35` y `S' = −0.2` ⇒ cierra `signal_flip`; salida por tiempo: 49 h con +0,1R ⇒ `time_exit`, con +0,5R no; trailing: long entrada 100, d 1%, mark 101 ⇒ stop a 100 (breakeven), mark 103 ⇒ stop a 102; cada apertura emite `position_opened` con `phrase`; `decisions` emite una fila por vista incluyendo las bloqueadas; la sombra abre con pesos 1 aunque el aprendido no abra.
- [ ] **Step 2–4:** fallar, implementar, pasar. **Commit** — `feat(core): motor de trading`.

---

### Task 13: Replay determinista con orden intra-vela

**Files:**
- Create: `packages/core/src/replay/{clock,intra-candle,replay-runner}.ts`
- Test: `packages/core/test/replay/*.test.ts`, fixture `packages/core/test/fixtures/replay-mini.json`

**Interfaces:**
- Consumes: Task 12, Task 9, Task 4.
- Produces: `resolveCandle(position: Position, lastCandle: Candle, markCandle: Candle, exits): CandleOutcome` con el orden canónico (spec 6) devolviendo `{ closedBy: CloseReason | null; exitPrice; newStop; newBest }`; `runReplay(input: { symbolsByDay: Record<string /*YYYY-MM-DD*/, string[]>; candles: Record<symbol, Record<'15m'|'1h'|'4h', { last: Candle[]; mark: Candle[] }>>; funding: Record<symbol, FundingEvent[]>; futures: Record<symbol, FuturesSnapshot[]>; infos; btc; settings; learningInit; capital; from; to; paramTuning: boolean; sink; progress?: (p: { day; of }) => void }): ReplayResult` (`{ closed, equity, decisions, stats, learningFinal, signalHistogram, correlation, missingSignalWindows, universeByDay }`), avanzando el reloj simulado vela a vela, decidiendo al cierre de cada 15m con `MarketView` causal, llenando a la apertura de la vela siguiente, aplicando funding en su `at`, y usando `resolveCandle` para salidas; el resultado es determinista (mismo input ⇒ mismo JSON).

- [ ] **Step 1: Tests intra-vela**: long entrada 100, stop 99, TP 102, vela `o 100 h 103 l 98.5 c 102` ⇒ `closedBy 'stop'` (adverso primero) y el trailing **no** se activó; vela `o 97` ⇒ fill en 97 (gap); vela `o 100 h 103 l 99.5` ⇒ TP; con trailing activo (best 103) y vela `h 104 l 101.5`, stop en 102 ⇒ adverso 101,5 < 102 ⇒ cierra `trailing_stop` antes de subir el stop con el máximo.
- [ ] **Step 2: Test de determinismo** con el fixture mini (2 símbolos, 5 días): correr dos veces ⇒ `JSON.stringify` idéntico; y "fuga de futuro": un fixture donde la vela de 4h en curso implicaría una entrada distinta ⇒ el replay no la ve (misma decisión que con la vela ausente).
- [ ] **Step 3–5:** fallar, implementar, pasar. **Commit** — `feat(core): replay determinista`.

---

### Task 14: Aprendizaje (pesos, confianza, fiabilidad, parámetros, sombra)

**Files:**
- Create: `packages/core/src/learning/{state,weights,confidence,reliability,params,shadow}.ts`
- Test: `packages/core/test/learning/*.test.ts`

**Interfaces:**
- Produces: `initialLearningState(now): LearningState` (pesos 1, params de `DEFAULT_SETTINGS`); `updateWeightsFromTrade(state, closed: ClosedPosition, settings.learning, now): { state; log: LearningChange[] }` (spec 8.1: `c = s × dirección`, `r = clamp(R,−2,2)/2`, `η 0.02`, clamp `[0.2, 2]`, congelado hasta 50, tope semanal ±0,15 con `weeklyDelta` reiniciado al cambiar `weekStart`); `effectiveWeights(state, symbol): Record<SignalId, number>` con encogimiento `λ = n/(n+30)`; `updateConfidence(state, closed, settings, now)` (EMA α 0,2, penitencia 7 días tras 8 trades con conf < −0,5, vuelta en −0,2); `symbolMultiplier(state, symbol): number` = `clamp(1 + conf, 0.5, 1.0)`; `reliability(decisions: { signals; forwardReturn4h }[]): Record<SignalId, number>` (Spearman) y `applyReliability(state, rho, now)` (`w += 0.5·ρ` sujeto al tope semanal); `walkForward(input: { runFn: (params) => { trades: ClosedPosition[] }; grid; current; minTrades: 60; now }): { adopt: boolean; best; rejected: { params; expectancyR; reason }[] }` con las condiciones (a)–(d) de spec 8.3 (SE = sd(R)/√n, mejora > 2·SE y ≥ 0,1R, también mejor en validación, permanencia 7 días); `compareShadow(learned: { equity[]; trades }, shadow: {...}, capitalInicial, days = 14): { gapPp; sumRLearned; sumRShadow; enoughTrades; warn: boolean }` (warn si gapPp > 3 a favor de la sombra con ≥ 20 trades cada una).

- [ ] **Step 1: Tests**: 49 trades no cambian pesos, el 50º sí; una señal que votó +0,8 en un trade +2R sube `0.02×0.8×1 = 0.016`; 10 trades iguales no pasan el tope de 0,15 en la semana; `effectiveWeights` con `n = 30` ⇒ mitad global, mitad moneda; penitencia tras 8 trades de −1R (conf < −0,5) ⇒ `penalties[symbol] = now + 7d`, `symbolMultiplier = 0.5`; `walkForward` no adopta con 40 trades; adopta cuando mejora 0,3R con SE 0,1 y gana en validación; rechaza si la vigente tiene 3 días; `compareShadow` con sombra +5pp ⇒ `warn`.
- [ ] **Step 2–4:** fallar, implementar, pasar. **Commit** — `feat(core): aprendizaje acotado y cartera sombra`.

---

### Task 15: Barrel de `@sereno/core` e integración del motor con aprendizaje y sombra

**Files:**
- Modify: `packages/core/src/index.ts`, `packages/core/src/engine/engine.ts`
- Test: `packages/core/test/engine/learning-integration.test.ts`

- [ ] **Step 1: Test**: el motor, al cerrar un trade, llama a `updateWeightsFromTrade` y `updateConfidence` (si no está congelado) y emite `learning_updated` con `sampleSize`; `effectiveWeights(symbol)` alimenta `computeComposite`; la sombra usa pesos 1.
- [ ] **Step 2–3:** implementar, exportar todo desde `index.ts` (tipos, indicadores, señales, riesgo, cuenta, exchange, motor, replay, aprendizaje, stats, frases). `pnpm --filter @sereno/core test` ⇒ todo verde; `pnpm typecheck` verde. **Commit** — `feat(core): integración de aprendizaje en el motor`.

---

### Task 16: Esquema de base de datos y migraciones

**Files:**
- Create: `packages/db/drizzle.config.ts`, `packages/db/src/client.ts`, `packages/db/src/schema/{sessions,settings,symbols,universe-days,positions,position-events,decisions,equity-snapshots,market-snapshot,candles,futures-data,learning,bot,commands,auth,index}.ts`, `packages/db/migrations/*`, `packages/db/scripts/migrate.ts`
- Test: `packages/db/test/migrate.test.ts` (contra `DATABASE_URL_TEST`, por defecto `postgresql://postgres@127.0.0.1:5499/sereno_test`)

**Interfaces:**
- Produces: tablas de spec 10 con los nombres exactos (`sessions`, `settings`, `settings_history`, `symbols`, `universe_days`, `positions`, `position_events`, `decisions`, `equity_snapshots`, `market_snapshot`, `candles`, `futures_data`, `learning_state`, `learning_log`, `bot_status`, `bot_lease`, `bot_commands`, más `user`, `session`, `account`, `verification` de Better Auth generadas con `npx @better-auth/cli generate` y adaptadas a Drizzle); `createPooledDb(url)` (neon-serverless Pool) y `createDirectDb(url, { max = 4 })` (pg Pool); `migrate()` que aplica `migrations/`. Columnas jsonb tipadas con los tipos de `@sereno/core`. Índices: `candles (symbol, timeframe, price_type, open_time) unique`, `equity_snapshots (session_id, at desc)`, `decisions (session_id, candle_close_time desc)`, `positions (session_id, closed_at)`, `bot_commands (session_id, status, created_at)`. `market_snapshot` con `fillfactor = 50`.

- [ ] **Step 1: Test**: `migrate()` sobre la base de prueba limpia ⇒ todas las tablas existen (consulta a `information_schema.tables` contra la lista exacta) y la migración es idempotente (segunda corrida sin error).
- [ ] **Step 2–4:** fallar, implementar (`drizzle-kit generate`, revisar el SQL), pasar. **Commit** — `feat(db): esquema y migraciones`.

---

### Task 17: Repositorios

**Files:**
- Create: `packages/db/src/repos/{sessions,settings,symbols,positions,decisions,equity,market,candles,futures,learning,bot,commands}.ts`, `packages/db/src/index.ts`
- Test: `packages/db/test/repos/*.test.ts` (contra la base de prueba, cada test en una transacción que se revierte o con `TRUNCATE` previo)

**Interfaces:**
- Produces (firmas mínimas que usan bot y web): `sessionsRepo.createLive({ capitalInicial, settings, learningOrigin })`, `getActiveLive()`, `archive(id, { closeOpen: true })`, `listAll()`, `get(id)`, `updateProgress(id, { status, progreso, mensaje })`; `settingsRepo.get(sessionId)`, `update(sessionId, patch, expectedVersion)` ⇒ `{ ok: boolean; version }` (optimistic locking) + `history`; `commandsRepo.enqueue(cmd)` (ON CONFLICT DO NOTHING), `claimNext(sessionId, instanceId)` (la sentencia atómica de spec 10), `expireStale(sessionId)`, `finish(id, result | error)`, `cancel(id)`, `listRecent(sessionId)`; `botRepo.heartbeat(status)`, `acquireLease(sessionId, instanceId, ttlMs)` ⇒ boolean, `get(sessionId)`; `positionsRepo.upsertOpen`, `close`, `listOpen(sessionId, { shadow })`, `listClosed(sessionId, filters, paging)`, `addEvent`; `decisionsRepo.insertBatch`, `fillForwardReturns`, `listJournalCandidates`, `pruneOlderThan`; `equityRepo.insert`, `series(sessionId, from, to, kind)`, `pruneMinuteOlderThan`; `marketRepo.upsert(sessionId, payload)`, `get(sessionId)`; `candlesRepo.upsertMany`, `range(symbol, tf, priceType, from, to)`; `futuresRepo.insert`, `latest`, `range`; `learningRepo.get`, `save`, `appendLog`, `listLog`; `symbolsRepo.upsertMany`, `all`.

- [ ] **Step 1: Tests**: claim atómico — dos claims concurrentes del mismo comando devuelven uno y `null`; un comando con `expires_at` pasado queda `expired` y `claimNext` no lo devuelve; `settings.update` con versión vieja devuelve `ok: false`; `acquireLease` falla para una segunda instancia mientras el lease está vigente y pasa cuando venció; `enqueue` dos veces con el mismo uuid inserta una fila.
- [ ] **Step 2–4:** fallar, implementar, pasar. **Commit** — `feat(db): repositorios`.

---

### Task 18: Cliente REST de Binance con limitador y cliente websocket `/market`

**Files:**
- Create: `apps/bot/src/binance/{types,rate-limiter,rest,ws}.ts`, `apps/bot/src/binance/fake/{server,fixtures}.ts`, `apps/bot/src/logger.ts`, `apps/bot/src/config.ts`
- Test: `apps/bot/test/binance/*.test.ts` (contra el servidor falso: `undici`/`http` local + `ws` server)

**Interfaces:**
- Produces: `class RateLimiter { constructor({ weightPerMinute: 2400; dataRequestsPer5m: 1000; fundingRequestsPer5m: 500 }); acquire(kind: 'weight' | 'data' | 'funding', weight: number): Promise<void>; observeHeader(usedWeight1m: number): void }`; `class BinanceRest { constructor({ baseUrl, limiter, fetch }); exchangeInfo(): Promise<ContractMeta[] & filters>; klines(symbol, interval, { startTime, endTime, limit }): Promise<Candle[]>; markPriceKlines(...)`, `ticker24h(): Promise<{ symbol; quoteVolume; priceChangePercent }[]>`, `premiumIndex(symbol?)`, `bookTicker(symbol)`, `fundingRate(symbol, { startTime, endTime, limit })`, `fundingInfo()`, `openInterestHist(symbol, '1h', limit)`, `globalLongShortAccountRatio(symbol, '1h', limit)`, `takerLongShortRatio(symbol, '1h', limit)`, `dailyKlines(symbol, startTime, endTime)` }` con backoff en 429/418 y error tipado `BinanceGeoBlocked` en 451; `class MarketStream { constructor({ url: 'wss://fstream.binance.com/market/stream', symbols, streams: ['kline_15m','kline_1h','kline_4h','markPrice@1s'], WebSocket }); on('kline', (symbol, tf, candle: Candle) => void); on('mark', (tick: MarkTick) => void); on('gap', ({ symbol, tf, from, to }) => void); on('status', (s: 'connected'|'reconnecting'|'closed') => void); start(); stop(); scheduleReconnectAt(t) }` con pong proactivo, reconexión con backoff, reconexión programada a las 23 h evitando `t % 15min < 10s`, y detección de huecos por `openTime` saltado.

- [ ] **Step 1: Tests**: el limitador frena la llamada 241 de peso 10 hasta que pasa el minuto (reloj falso); 451 ⇒ `BinanceGeoBlocked`; 429 ⇒ reintento con backoff; `klines` convierte el array de Binance a `Candle` con `closed = true` y `closeTime = openTime + ms − 1`; el stream construye la URL `…/market/stream?streams=btcusdt@kline_15m/btcusdt@markPrice@1s/…` (lowercase) y emite `kline` sólo con `x = true` para el evento de cierre, emite `mark` con `fundingRate` de `r` y `nextFundingTime` de `T`; al recibir una vela con `openTime` dos períodos adelante emite `gap`; nunca usa `/ws` ni `/stream` sin ruta (test que falla si la URL no contiene `/market/`).
- [ ] **Step 2–4:** fallar, implementar, pasar. **Commit** — `feat(bot): cliente REST con limitador y stream /market`.

---

### Task 19: Calentamiento, universo y datos de futuros (jobs)

**Files:**
- Create: `apps/bot/src/live/warmup.ts`, `apps/bot/src/jobs/{universe,futures-data,cleanup}.ts`
- Test: `apps/bot/test/jobs/*.test.ts`

**Interfaces:**
- Consumes: Task 18, Task 17, `selectUniverse`.
- Produces: `refreshSymbols(rest, repos)` (exchangeInfo + fundingInfo ⇒ `symbols`), `computeUniverse(rest, repos, settings, openSymbols, today)` ⇒ guarda `universe_days` y devuelve símbolos; `warmup(rest, repos, symbols, { candlesPerTf: 300 }, progress)` ⇒ velas `last` y `mark` por REST encoladas (≤ 150 llamadas de peso 10 por minuto) y guardadas; `pollFuturesData(rest, repos, symbols)` cada 5 minutos (OI, ratios, período 1h) con el límite de 1.000/5min; `cleanup(repos)` (decisions > 30 días, equity por minuto > 90 días).

- [ ] **Step 1: Tests** con el servidor falso: `warmup` pide 300 velas por marco y tipo por símbolo y las guarda; `computeUniverse` excluye TradFi y stables y guarda el snapshot del día; `pollFuturesData` guarda `futures_data` con `openInterest1hAgo` derivado.
- [ ] **Step 2–4:** fallar, implementar, pasar. **Commit** — `feat(bot): calentamiento, universo y datos de futuros`.

---

### Task 20: Runtime en vivo (lease, latido, comandos, persistencia, ciclo)

**Files:**
- Create: `apps/bot/src/live/{runtime,scheduler,lease,heartbeat,commands,persist,pause}.ts`, `apps/bot/src/index.ts` (CLI `live` por defecto)
- Test: `apps/bot/test/live/*.test.ts`

**Interfaces:**
- Consumes: Tasks 12–19.
- Produces: `startLive({ repos, rest, stream, settingsLoader, clock })` que: toma el lease o entra en `waiting_lease`; carga `settings`, `learning_state`, sesión activa; reconstruye `PaperExchange` y `TradingEngine` desde `positions` abiertas (recreando órdenes de stop/TP); corre `warmup`; se suscribe al stream; en cada cierre de 15m espera hasta `decisionDeadlineMs` a que lleguen las velas de todos los símbolos, construye los `MarketView` y llama `engine.onCandleClose`; en cada `mark` llama `engine.onMarkTick` y actualiza el snapshot de mercado (UPSERT cada 5 s con precios, cambio 24h, `S'`); aplica funding en `nextFundingTime` con la tasa `r`; persiste todos los `EngineEvent` (posiciones, eventos, decisiones por lote, equity por minuto y por evento, learning); latido + lease cada 10 s con `settingsVersionApplied` y `flags`; relee `settings` cuando cambia la versión y aplica pausa; consume comandos cada 3 s (claim atómico, `expireStale`, ejecuta `close_position`, `close_all`, `release_protected`, `reset_learning`, encola `run_replay` al worker); al reconectar con hueco, rellena velas por REST y reevalúa abiertas (`stop_missed_offline`).

- [ ] **Step 1: Tests** (`commands.test.ts`): un `close_position` con `expiresAt` en el pasado queda `expired` y la posición sigue abierta; un `close_position` válido cierra y marca `done`; `close_all` cierra todas; una segunda instancia sin lease no ejecuta comandos ni abre posiciones. (`runtime.test.ts`): con el servidor falso, un cierre de 15m con las 2 velas presentes produce 2 filas en `decisions`; si falta una vela a los 3 s, la decisión de ese símbolo es `no_candle`; un cambio de `settings.pause.paused` a `true` hace que el siguiente ciclo bloquee entradas con `paused` pero un tick que cruza el stop cierra; el latido escribe `settingsVersionApplied`.
- [ ] **Step 2–4:** fallar, implementar, pasar. **Commit** — `feat(bot): runtime en vivo`.

---

### Task 21: Replay en el bot (descarga, worker, progreso) y jobs de aprendizaje

**Files:**
- Create: `apps/bot/src/replay/{download,run,worker}.ts`, `apps/bot/src/jobs/{forward-returns,param-tuning}.ts`, CLI `replay` en `apps/bot/src/index.ts`
- Test: `apps/bot/test/replay/*.test.ts`

**Interfaces:**
- Consumes: Task 13, 14, 18, 17.
- Produces: `downloadReplayData(rest, repos, { from, to, settings }, progress)` ⇒ universo por día (velas diarias), velas `last`+`mark` de 15m/1h/4h con calentamiento, funding, OI/ratios donde existan; `runReplaySession(repos, sessionId, params, progress)` que crea la sesión `replay`, descarga, corre `runReplay` de core, persiste posiciones, decisiones, equity, learning final y el reporte (`sessions.report` jsonb), actualizando `estado/progreso/mensaje`; `worker.ts` lo corre en un `worker_threads` Worker con cancelación; `forwardReturnsJob` (cada hora rellena `forwardReturn4h/24h` con las velas guardadas); `paramTuningJob` (domingos 00:30 UTC: `walkForward` con `runReplay` sobre los últimos 60 días en memoria, señales precalculadas una vez, pesos congelados, sin sombra; aplica y registra en `learning_log` o registra los rechazos).

- [ ] **Step 1: Tests**: con el servidor falso y 3 días de datos de 2 símbolos, `runReplaySession` termina en `listo` con `progreso 1`, crea posiciones cerradas en la sesión y un reporte con `stats`; `cancel` a mitad deja `cancelado`; `forwardReturnsJob` rellena retornos usando el cierre 16 velas después; el CLI `pnpm bot replay --days 3 --capital 1000` corre contra `DATABASE_URL`.
- [ ] **Step 2–4:** fallar, implementar, pasar. **Commit** — `feat(bot): replay y jobs de aprendizaje`.

---

### Task 22: Arranque local, `caffeinate`, Dockerfile y seed de usuario

**Files:**
- Create: `apps/bot/Dockerfile`, `apps/bot/bin/sereno-bot.sh` (envuelve `caffeinate -i` en macOS), `packages/db/scripts/seed-user.ts`
- Modify: `package.json` raíz (`"bot": "bash apps/bot/bin/sereno-bot.sh"`, `"db:seed-user"`)
- Test: `packages/db/test/seed-user.test.ts`

- [ ] **Step 1: Test**: `seedUser({ email: 'owner@example.com', password })` crea `user` + `account` (credential) con hash de Better Auth (usar `auth.api.signUpEmail` internamente con `disableSignUp` levantado sólo en el script) y es idempotente (segunda corrida actualiza la contraseña).
- [ ] **Step 2–3:** implementar; `docker build apps/bot` compila (solo verificar que el Dockerfile es válido con `docker build --check` si está disponible, si no, omitir). **Commit** — `chore(bot): arranque local, Dockerfile y seed de usuario`.

---

### Task 23: App web base: Next.js 16, Tailwind 4, tokens, tipografía, tema, PWA

**Files:**
- Create: `apps/web/{next.config.ts,postcss.config.mjs,app/globals.css,app/layout.tsx,app/manifest.ts,app/icon.svg,lib/fonts.ts,lib/theme.ts,components/ui/{button,chip,field,toggle,segment,skeleton,toast,confirm,sheet,number}.tsx}`, `apps/web/components/ui/sheet.tsx` (física de spec 11.3), `apps/web/lib/motion.ts` (springs: `springDefault = { type: 'spring', bounce: 0, duration: 0.35 }`, `springGesture = { type: 'spring', bounce: 0.2, duration: 0.4 }`, `project(v)`, `rubberband(overshoot, dimension, 0.55)`), `apps/web/lib/format.ts` (reexporta `@sereno/shared`)
- Test: `apps/web/test/ui/{number,sheet}.test.tsx` (Vitest + jsdom + Testing Library)

**Interfaces:**
- Produces: tokens como CSS custom properties en `globals.css` exactamente los de spec 11.2 (`--bg`, `--surface`, `--ink`, `--muted`, `--line`, `--gain`, `--loss`, `--gain-soft`, `--loss-soft`) con `@media (prefers-color-scheme: dark)` y `@theme` de Tailwind 4 mapeando `bg-surface`, `text-ink`, etc.; Instrument Sans con `next/font/google` (`axes: ['wdth']` no; sólo weight variable); `<AnimatedNumber value format />` (interpola sólo si cambio < 5% y pestaña visible en los últimos 30 s, duración 250 ms, spring sin rebote; fundido 150 ms si no; `useReducedMotion` ⇒ fundido); `<Sheet open onClose title>` (celu: hoja inferior arrastrable con proyección de velocidad, rubber-band, scrim con escala 0,98; desktop ≥ 900px: panel centrado 560px, Esc y clic afuera; `layoutId` opcional); `<Confirm>`; `<Toast>` con "Deshacer" de 6 s; `<Chip tone="gain|loss|muted|info">`; `<Segment>`; `<Skeleton>`; manifest PWA (`display: standalone`, `theme_color` claro y oscuro vía `<meta>` con media), `viewport-fit=cover`.

- [ ] **Step 1: Tests**: `AnimatedNumber` renderiza `US$ 1.247,80` y al cambiar a `US$ 2.500,00` (cambio > 5%) renderiza el valor final sin interpolar; `Sheet` cierra con Esc en desktop y renderiza el título.
- [ ] **Step 2–4:** fallar, implementar, pasar; `pnpm --filter @sereno/web build` pasa. **Commit** — `feat(web): base de la app, tokens, tipografía y componentes`.

---

### Task 24: Autenticación (Better Auth, lista blanca, Google gateado, pantalla de acceso)

**Files:**
- Create: `apps/web/lib/auth.ts`, `apps/web/lib/auth-client.ts`, `apps/web/lib/env.ts` (`@t3-oss/env-nextjs`), `apps/web/app/api/auth/[...all]/route.ts`, `apps/web/proxy.ts`, `apps/web/app/acceso/page.tsx`, `apps/web/components/auth/{google-button,password-form}.tsx`, `apps/web/lib/session.ts` (`requireSession()`)
- Test: `apps/web/test/auth/allowlist.test.ts`

**Interfaces:**
- Produces: `auth` (Better Auth con `drizzleAdapter(db, { provider: 'pg' })`, `emailAndPassword: { enabled: true, disableSignUp: true }`, `socialProviders.google` sólo si hay credenciales (`googleEnabled`), `databaseHooks.user.create.before` que rechaza emails fuera de `ALLOWED_EMAILS` (lowercase, separados por coma), y el hook de validación de perfil OAuth en cada sign-in según la versión instalada — leer `node_modules/better-auth/docs` o el README para confirmar el nombre, `account.accountLinking: { enabled: true, trustedProviders: ['google'] }`, `plugins: [nextCookies()]`); `requireSession()` para páginas y handlers; `proxy.ts` redirige a `/acceso` sin cookie; página `/acceso` con nombre, frase "Dashboard del bot. Sólo para la cuenta autorizada.", botón "Entrar con Google" (si `googleEnabled`), formulario email + contraseña, y mensaje de rechazo "Esta cuenta no tiene acceso a Sereno" + "Probar con otra cuenta" cuando `?error`.

- [ ] **Step 1: Test**: `isAllowed('Owner@Example.com', 'owner@example.com')` ⇒ true; otro email ⇒ false; `user.create.before` lanza para un email no permitido.
- [ ] **Step 2–4:** fallar, implementar, pasar; verificar manualmente en `localhost` que el login con contraseña (usuario del seed) entra y un email no permitido es rechazado. **Commit** — `feat(web): acceso con Better Auth y lista blanca`.

---

### Task 25: Capa de datos del dashboard: queries, endpoint `/api/live`, acciones

**Files:**
- Create: `apps/web/lib/db.ts`, `apps/web/lib/queries/{session,resumen,posiciones,monedas,aprendizaje,ajustes}.ts`, `apps/web/app/api/live/route.ts`, `apps/web/lib/actions/{settings,commands,session}.ts`, `apps/web/lib/live/{use-live,provider}.tsx`, `apps/web/lib/derive.ts`
- Test: `apps/web/test/lib/{derive,live-route}.test.ts`

**Interfaces:**
- Produces: `getContext(sessionId?: string)` ⇒ `{ session, isActive, isReplay, isArchived }`; `getResumenData(sessionId)`; `getPosicionesData`; `getMonedasData`; `getAprendizajeData`; `getAjustesData`; `deriveHeadline(snapshot, open, marks, now)` (total = equity − I₀, realizado, no realizado, hoy desde 00:00 BA, veredicto corto, offline); `GET /api/live?session=…&since=<version>` que devuelve `{ version, market, open, botStatus, equityLast, settingsVersion, offline: boolean }` o `{ unchanged: true }` (version = `market_snapshot.version` + `bot_status.updated_at` + `settings.version` + máximo `positions.updated_at`); `useLive(sessionId)` (TanStack Query, 5 s visible y en vivo, 30 s pausado/sin conexión, pausa con `visibilityState`, `placeholderData: keepPreviousData`); acciones: `updateSettings(patch, expectedVersion)` ⇒ `{ ok, version }` o conflicto; `enqueueCommand(kind, payload)` (uuid del cliente); `cancelCommand(id)`; `createSession({ capital, protectPct, mode, learningOrigin })`; `archiveSession()`; `releaseProtected()`; `resetLearning()`; `runReplay(params)`; todas con `requireSession()` y `requestedBy`.

- [ ] **Step 1: Tests**: `deriveHeadline` con saldo 1.247,80, I₀ 1.000, abiertas −52,10 ⇒ `total 195.7`, `realized 247.8`, `unrealized -52.1`, `signsDiffer: false`; con realizado +20 y abiertas −50 ⇒ `signsDiffer true`; `offline` cuando el latido tiene 61 s; el handler devuelve `{ unchanged: true }` cuando `since` coincide.
- [ ] **Step 2–4:** fallar, implementar, pasar. **Commit** — `feat(web): capa de datos, endpoint en vivo y acciones`.

---

### Task 26: Shell de navegación, contexto de sesión y estados globales

**Files:**
- Create: `apps/web/app/(app)/layout.tsx`, `apps/web/app/s/[sessionId]/layout.tsx`, `apps/web/components/nav/{bottom-bar,top-bar,session-chip,context-band}.tsx`, `apps/web/components/status/{offline-band,bot-status-chips,error-band}.tsx`, `apps/web/app/(app)/loading.tsx` y esqueletos por pantalla, `apps/web/app/error.tsx`, `apps/web/app/not-found.tsx`
- Test: `apps/web/test/nav/shell.test.tsx`

- [ ] **Step 1: Tests**: la barra inferior tiene exactamente "Resumen, Posiciones, Monedas, Aprendizaje, Ajustes"; en contexto `/s/[id]` la banda muestra "Replay · 90 días · 2 ago → 31 oct" y el botón "Volver a la simulación actual"; con `offline` el `<title>` empieza con "● Sin conexión"; el chip muestra "Simulado" / "Replay · 90 días".
- [ ] **Step 2–4:** implementar (barra translúcida con `backdrop-filter`, `safe-area-inset-bottom`, `prefers-reduced-transparency` ⇒ sólida), pasar. **Commit** — `feat(web): navegación, contexto de sesión y estados globales`.

---

### Task 27: Pantalla Resumen

**Files:**
- Create: `apps/web/app/(app)/page.tsx`, `apps/web/app/s/[sessionId]/page.tsx`, `apps/web/components/resumen/{headline,secondary-line,verdict-line,equity-chart,open-positions,capital-card,journal,bot-status,pause-sheet,first-run}.tsx`, `apps/web/components/charts/{equity-chart,sparkline}.tsx`
- Test: `apps/web/test/resumen/resumen.test.tsx`

**Interfaces:**
- Consumes: Task 25 datos, Task 23 componentes, frases de `@sereno/core` (`headline`, `capitalCard`).
- Produces: la pantalla de spec 11.1.1 completa: titular (todas las variantes, crossfade al cambiar de verbo), línea secundaria, veredicto, curva de equity (SVG propio con `d3-shape`/`d3-scale`: línea 2px, área 10%, grilla hairline, huecos > 5 min punteados, tocar y mantener muestra etiqueta, rangos hoy/7d/30d/todo, saldo opcional), abiertas (tap ⇒ hoja con `layoutId`; swipe izquierda ⇒ "Cerrar ahora" con histéresis 10px), tarjeta de capital (tres estados + reinversión + riesgo del blindado), diario (encabezado del tramo, 5 entradas, "Ver todo", liquidaciones destacadas y banda), estado del bot (chips + Pausar/Reanudar con hoja de dos opciones), primer uso (formulario de dos pasos + estados post-creación), secuencia de entrada única (40 ms de escalonado, sólo en carga inicial), sin conexión (banda, números apagados con hora, acciones deshabilitadas), contexto replay/archivada (pasado, "Abiertas al final", reporte en lugar de estado, sin acciones).

- [ ] **Step 1: Tests**: renderiza "Vas ganando US$ 247,80 desde el 14 de octubre." con los datos del ejemplo; "sin conexión": con latido viejo aparece "Bot sin conexión desde las 14:32" y el botón Pausar está deshabilitado; primer uso sin sesión muestra "Empezar a simular"; contexto replay muestra "Hubiera ganado" y no muestra "Pausar"; tarjeta de capital estado 2 muestra "Blindaste los US$ 1.000 iniciales".
- [ ] **Step 2–4:** fallar, implementar, pasar. Revisión visual en 375px y desktop con capturas en `docs/superpowers/review/resumen-{mobile,desktop}.png` (Playwright). **Commit** — `feat(web): pantalla Resumen`.

---

### Task 28: Pantalla Posiciones y hoja de detalle de trade

**Files:**
- Create: `apps/web/app/(app)/posiciones/page.tsx`, `apps/web/app/s/[sessionId]/posiciones/page.tsx`, `apps/web/components/posiciones/{open-table,open-card,closed-list,filters,stats,verdict-card,trade-sheet,stop-tp-bar}.tsx`, `apps/web/components/charts/candle-chart.tsx` (lightweight-charts con marcadores de entrada, stop, TP y salida; en celu `handleScroll.vertTouchDrag = false`, altura 220)
- Test: `apps/web/test/posiciones/posiciones.test.tsx`

- [ ] **Step 1: Tests**: la tarjeta de celu muestra las tres líneas del spec para SOL ("SOL · Long 5x · +US$ 12,40 (+4,1%)", "entró a 142,10 · ahora 148,30 · 3 h"); el filtro "liquidadas" deja sólo las `liquidation`; la tarjeta de veredicto muestra "faltan 77" con 23 trades; "Cerrar ahora" abre confirmación con el texto "Vas a cerrar SOL por +US$ 12,40".
- [ ] **Step 2–4:** fallar, implementar, pasar; capturas. **Commit** — `feat(web): pantalla Posiciones`.

---

### Task 29: Pantalla Monedas (tablero) y hoja de moneda

**Files:**
- Create: `apps/web/app/(app)/monedas/page.tsx`, `apps/web/app/s/[sessionId]/monedas/page.tsx`, `apps/web/components/monedas/{board,tile,lean-bar,coin-sheet,signal-bars}.tsx`
- Test: `apps/web/test/monedas/board.test.tsx`

- [ ] **Step 1: Tests**: 30 baldosas ordenadas (con posición primero, después por |S'|); la baldosa de `1000PEPEUSDT` muestra "PEPE"; estados degradada/enfriamiento/penitencia con sus textos; la barra de inclinación con `S' = 0.72` tiene `left: 50%` y `width: 36%`; tocar abre la hoja con las barras de señales y "Fijar"/"Excluir" (ocultos en contexto replay).
- [ ] **Step 2–4:** fallar, implementar (grilla 3/2/5/6 columnas; "latido" al abrir posición con `useReducedMotion` ⇒ sólo color), pasar; capturas. **Commit** — `feat(web): tablero de monedas`.

---

### Task 30: Pantalla Aprendizaje y replays

**Files:**
- Create: `apps/web/app/(app)/aprendizaje/page.tsx`, `apps/web/app/s/[sessionId]/aprendizaje/page.tsx`, `apps/web/components/aprendizaje/{changes-journal,shadow-compare,signals-table,coins-confidence,params-card,controls,replays-list,run-replay-sheet,replay-report}.tsx`
- Test: `apps/web/test/aprendizaje/aprendizaje.test.tsx`

- [ ] **Step 1: Tests**: con 23 trades muestra "juntando datos: 23 de 50"; la comparación muestra "+3,2 puntos" y el aviso cuando `warn`; la lista de replays muestra "Simulando · día 41 de 90" y "Cancelar"; "Correr un replay" abre la hoja con días, capital, aprendizaje (cero/vigente) y ajuste de parámetros; con bot sin conexión la hoja avisa que queda en cola.
- [ ] **Step 2–4:** fallar, implementar, pasar; capturas. **Commit** — `feat(web): pantalla Aprendizaje y replays`.

---

### Task 31: Pantalla Ajustes

**Files:**
- Create: `apps/web/app/(app)/ajustes/page.tsx`, `apps/web/app/s/[sessionId]/ajustes/page.tsx`, `apps/web/components/ajustes/{capital-section,mode-section,custom-fields,risk-section,universe-section,bot-section,real-mode-section,account-section,live-preview}.tsx`
- Test: `apps/web/test/ajustes/ajustes.test.tsx`

- [ ] **Step 1: Tests**: la vista previa del blindaje dice "Cuando la ganancia llegue a 70% (US$ 700), blindo los US$ 1.000 iniciales y sigo sólo con lo ganado."; en modo "Yo fijo tamaño y salidas" aparecen los campos y la traducción "SL 2% del precio = −US$ 5 de los US$ 50 (−10%)"; con apalancamiento 10 y SL 12% aparece el aviso de liquidación; guardar ajustes muestra el toast con "Deshacer"; "Cerrar todo" abre confirmación con el total; "Nueva simulación" abre confirmación con el texto del spec; versión vieja ⇒ mensaje de conflicto y recarga; en contexto replay todo es sólo lectura.
- [ ] **Step 2–4:** fallar, implementar, pasar; capturas. **Commit** — `feat(web): pantalla Ajustes`.

---

### Task 32: Prueba de humo end-to-end y revisión visual completa

**Files:**
- Create: `apps/web/e2e/smoke.spec.ts`, `apps/web/playwright.config.ts`, `docs/superpowers/review/README.md` (índice de capturas)
- Modify: `package.json` raíz (`"e2e"`)

- [ ] **Step 1: Escribir el smoke** (contra `pnpm dev` con la base local sembrada por el seed y una sesión creada por un script `packages/db/scripts/seed-demo.ts` que inserta una simulación con 23 trades, 3 abiertas, equity y decisiones de ejemplo): login con contraseña ⇒ Resumen muestra "Vas ganando"; navegar las 5 pestañas; "Pausar" ⇒ `settings.pause.paused = true` en la base; viewport 375×812 y 1280×800, con `reducedMotion: 'reduce'` y sin él; capturas en `docs/superpowers/review/`.
- [ ] **Step 2: Correr** `pnpm e2e` ⇒ PASS. Revisar cada captura contra los mockups y la sección 11; corregir desvíos visuales (espaciado, jerarquía, tipografía).
- [ ] **Step 3: Commit** — `test(web): prueba de humo y capturas de revisión`.

---

### Task 33: Corrida real en vivo, documentación y entrega

**Files:**
- Modify: `README.md`; Create: `resumen.md` y `preguntas.md` en la raíz (los mantiene el controlador)

- [ ] **Step 1:** Con la base local migrada y el usuario sembrado: `pnpm bot` en segundo plano (log en `.local/bot.log`), verificar en 20 minutos que hay latido, snapshot de mercado y decisiones; `pnpm bot replay --days 30` y verificar que la sesión replay termina en `listo` con reporte.
- [ ] **Step 2:** Abrir el dashboard local y verificar las 5 pantallas con datos reales (capturas finales).
- [ ] **Step 3:** Documentar en `README.md` arranque, variables, comandos, cómo provisionar Neon (`marrona-neon-db`) y desplegar a Vercel, cómo registrar el callback de Google. **Commit** — `docs: README y entrega`.
