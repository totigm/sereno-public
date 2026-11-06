# Sereno — operación con plata real: plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Una sesión de tipo real (`kind = 'live'`) que opera futuros USDT-M de Binance (testnet o mainnet) con el mismo motor que la simulación, en el mismo proceso que la sesión en papel, con capital asignado, tope de pérdida duro, stops siempre puestos en Binance, interruptor por dashboard y CLI, y un dashboard que la muestra marcada como "Plata real".

**Architecture:** El motor puro deja de depender de un "simulador" y pasa a depender de `EngineExchange` (la misma forma que hoy tiene `SimulatedExchange`, con tres agregados chicos: `StopOrder` con cantidad, `protectiveOrders` y más motivos de disparo y de rechazo). `PaperExchange` la implementa sin cambiar su comportamiento; el adaptador real (`apps/bot/src/real/exchange.ts`, con IO, fuera de core) también: los fills de stop/TP/liquidación y el funding que informa Binance (user data stream + REST) se encolan en una `RealAccount` y se entregan al motor por `processTick` y `applyFunding`, el mismo camino del simulador. El runtime pasa de una sesión a dos "slots" (papel y real) con lease propio; la real comparte el stack de mercado en mainnet y usa uno propio, en memoria, en testnet. Todo lo que hace que la real abra (o no) lo decide una función pura de gating, y el adaptador es quien rechaza abrir: el motor no sabe si es real.

**Tech Stack:** TypeScript 5.9 strict, Node 22, pnpm 12 + Turborepo, Vitest 4, zod 4, Drizzle 0.45 + drizzle-kit 0.31 (`pnpm db:generate`), `ws` 8, Next.js 16 + React 19, Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-01-sereno-real-trading-design.md` (extiende `docs/superpowers/specs/2026-10-31-sereno-trading-bot-design.md`).

## Global Constraints

- El motor en `packages/core` sigue puro: sin IO ni reloj. El adaptador real vive en `apps/bot/src/real/`; el stub `packages/core/src/exchange/binance-exchange.ts` se borra (Task 4).
- Papel y replay no cambian: `pnpm vitest run packages/core/test/replay` y `packages/core/test/exchange/paper-exchange.test.ts` pasan **sin editar esos archivos**. El tope de pérdida al abrir queda apagado con `risk.lossCap = 1` (100%), que es el default de `DEFAULT_SETTINGS`.
- Tope de pérdida de la sesión real: por defecto **50%** del capital asignado, configurable entre **10% y 100%**. Piso = `capitalInicial × (1 − tope)`.
- Llaves en orden: `BINANCE_TRADE_API_KEY` y `BINANCE_TRADE_API_SECRET` (aparte de la de sólo lectura, que queda como está); `SERENO_REAL_TRADING=on` (exactamente `on`); `BINANCE_ENV=testnet|mainnet`, por defecto `testnet`.
- Siempre margen **aislado**, modo **one-way**, nunca `closePosition=true`. Stop `STOP_MARKET` y TP `TAKE_PROFIT_MARKET` por la **API de órdenes algorítmicas** (`POST/DELETE /fapi/v1/algoOrder`, `GET /fapi/v1/openAlgoOrders`, eventos `ALGO_UPDATE` con `clientAlgoId`), con `reduceOnly=true`, la cantidad exacta del bot y `workingType=MARK_PRICE`. Las de `/fapi/v1/order` con esos tipos se rechazan con −4120.
- Toda orden lleva id de cliente `sereno-<sesión corta>-…` (`newClientOrderId` en las de mercado, `clientAlgoId` en las algorítmicas). Qué es del bot lo decide la base, no Binance.
- Mover el stop: primero se pone el nuevo, después se cancela el viejo. Si el stop no se puede poner tras los reintentos, se cierra la posición a mercado en el acto.
- Reconciliación al arrancar y cada 60 s (cada 10 s mientras el user data stream está caído). `listenKey` renovado cada 30 min. Hora local a menos de 1 s de la de Binance.
- Peso de API por IP: 2.400/min compartido entre las dos sesiones en mainnet; la real tiene prioridad para órdenes y reconciliación.
- Secrets nunca en logs, base, payloads del dashboard ni mensajes de error. Firmas HMAC con `apps/bot/src/binance/signing.ts`.
- Ningún test toca Binance de verdad: todo contra `apps/bot/src/binance/fake`. El constructor no corre nada contra testnet ni mainnet.
- El dashboard nunca llama a Binance; la base es su única fuente.
- Migraciones sólo con `pnpm db:generate` (nunca `push`); no se corre `db:migrate` contra la base de Toti.
- Copy en castellano rioplatense, voseo, oración, montos `US$ 1.247,80`, signo menos U+2212. Frases fijadas por el spec: "Plata real", "Cerrar todo y apagar", "tenés una posición tuya en SOL; no la toco", "apagada: falta X", "apagada por el tope de pérdida".
- La sesión real arranca con `DEFAULT_SETTINGS` (θ 0,55, k 2), aprendizaje de cero y **sin sombra**.
- Commits chicos estilo `feat(core): …` en castellano, terminados con `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **"Nueva simulación" con una sesión real activa.** Crear o archivar la simulación en papel no puede archivar, cerrar en la base ni tocar la sesión real (hoy `createSession` usa `getActiveLive()`, que devolvería cualquiera de las dos). Test en Task 2 (`sessions.test.ts`: "crear una simulación no archiva la real") y Task 13 (`actions.test.ts`).
2. **El stop dispara en Binance mientras el respaldo por tick del motor también cruzó.** `Desk.followMarket` llama a `closePosition` si la marca cruzó el stop antes de que llegue el evento: el adaptador tiene que devolver el fill del stop, nunca mandar una segunda orden ni abrir del otro lado. Test en Task 8 (`exchange.test.ts`: "cierre pedido con el stop ya disparado devuelve el fill del stop").
3. **Reinicio con stops ya puestos en Binance.** `PositionManager.restore` deja los ids en null y `protect` vuelve a colocar: en real eso duplicaría stops en cada reinicio. Test en Task 9 (`reconcile.test.ts`: "reiniciar no duplica stops").
4. **Toti suma a mano en una moneda del bot.** El bot sigue gestionando sólo su cantidad, no abre más ahí y nunca cierra más que lo suyo (adaptador y CLI). Tests en Task 8 ("con cantidad distinta cierra sólo la del bot") y Task 12 ("real-off cierra sólo la cantidad del bot").
5. **Reinicio sin `SERENO_REAL_TRADING=on`.** La sesión real no abre nada pero sigue moviendo el stop, saliendo por tiempo/señal y aplicando el tope. Test en Task 10 (`gate.test.ts`) y Task 16 (e2e "sin la variable sigue cuidando").

## Decisiones sobre lo que el spec deja al constructor

- Encaje del adaptador: se generaliza la interfaz (`EngineExchange`, Task 4) y el adaptador real la implementa con colas que se vacían en `processTick`/`applyFunding`; el motor no distingue papel de real.
- `session_kind`: se reusa `'live'` (ya existe); una activa **por tipo** (índice nuevo).
- Lo que se cierra por falta de stop lo resuelve el adaptador y llega al motor como disparo `'unprotected'`; el modo "sólo reducir riesgo" es el adaptador rechazando aperturas (`opening_disabled`), no una pausa de ajustes.
- `real_off` no vence; el dashboard apaga en la base en el acto y el comando cierra cuando el bot lo toma. El interruptor cierra con motivo `close_all`.
- Prender de nuevo después de un apagado manual exige reescribir el monto; después del tope, sólo una sesión nueva.
- La real no consulta datos de futuros ni muestrea spreads: lee los que guarda la de papel. En testnet sus velas viven sólo en memoria y su catálogo nunca pisa `symbols`.
- Funding real por `/fapi/v1/income` (por `tranId`), no por el evento del stream.
- Reintentos: stop 3 intentos (0, 500, 1.500 ms); espera de fills 3 s y después `userTrades`; chequeos cada 5 min, viejos a los 15 min.
- El selector de sesión aparece sólo con una sesión real activa; crearla vive en Ajustes › Plata real.

---

## Estructura de archivos

```
packages/shared/src/{types,settings,commands,real}.ts            vocabulario, lossCap, real_off, chequeos (Task 1)
packages/db/src/schema/{sessions,bot,enums,real}.ts · repos/{sessions,real}.ts · migrations/0006_*.sql (Task 2)
packages/core/src/risk/loss-floor.ts · engine/{entries,desk,account-guard,events}.ts · journal/{phrases,wait}.ts (Task 3)
packages/core/src/exchange/{types,errors,paper-exchange}.ts · engine/{position-manager,portfolio,types}.ts (Task 4)
apps/bot/src/binance/{http,rest,trade-rest,trade-types,trade-errors,precision,rate-limiter}.ts · fake/{trading,server}.ts (Task 5)
apps/bot/src/binance/user-stream.ts · fake/{user-stream,server}.ts (Task 6)
apps/bot/src/real/{client-id,account}.ts (Task 7) · real/exchange.ts (Task 8) · real/{reconcile,funding}.ts (Task 9)
apps/bot/src/config.ts · real/{checks,gate,readiness}.ts (Task 10)
apps/bot/src/live/{runtime,slot,market-stack,session,engine-build}.ts · real/{kit,controller,universe}.ts (Task 11)
apps/bot/src/real/real-off.ts · live/commands.ts · index.ts (Task 12)
apps/web/lib/queries/session.ts · components/nav/{session-switch,session-chip,session-labels}.tsx · components/shell/app-shell.tsx (Task 13)
apps/web/lib/{queries,actions}/real.ts · components/ajustes/real-section.tsx (Task 14)
apps/bot/src/live/payloads.ts · apps/web/lib/queries/journal.ts (Task 15) · apps/bot/test/real/e2e.test.ts (Task 16)
```

**Modelo sugerido por tarea:** mecánica = 1, 2, 13, 15; criterio medio = 10, 12, 14; criterio alto (el modelo más capaz) = 3, 4, 5, 6, 7, 8, 9, 11, 16.

---

### Task 1: Vocabulario compartido y `lossCap` *(mecánica)*

**Files:**
- Modify: `packages/shared/src/types.ts`, `packages/shared/src/settings.ts`, `packages/shared/src/commands.ts`, `packages/shared/src/index.ts`
- Create: `packages/shared/src/real.ts`
- Test: `packages/shared/test/settings.test.ts`, `packages/shared/test/commands.test.ts`, `packages/shared/test/real.test.ts`

**Interfaces:**
- Produces:
  - `SESSION_KINDS` sin cambios: `'live'` **es** la sesión de plata real (ya existe en el enum y en `session-labels.ts`).
  - `BOT_PHASES` agrega `'off'` al final.
  - `COMMAND_KINDS` agrega `'real_off'` (payload `{}`); **no** entra en `PRICE_SENSITIVE_COMMANDS` (apagar nunca vence).
  - `risk.lossCap: z.number().min(0.1).max(1).default(1)`; `DEFAULT_SETTINGS.risk.lossCap = 1`.
  - En `real.ts`: `BINANCE_ENVS = ['testnet','mainnet'] as const`, `type BinanceEnv`; `REAL_STATUSES = ['on','off','loss_floor'] as const`, `type RealStatus`; `type RealOffReason = 'user' | 'fatal'`; `REAL_LOSS_CAP_DEFAULT = 0.5`; `REAL_CHECK_IDS = ['keys','futures_enabled','no_withdrawals','ip_restricted','one_way','wallet','clock','multi_assets_off','fee_burn_off','env_match'] as const`, `type RealCheckId`; `interface RealCheck { id: RealCheckId; status: 'ok' | 'fail' | 'skipped'; detail: string }`; `REAL_CHECK_LABELS: Record<RealCheckId, string>`; `type RealGateMode = 'trading' | 'reduce_only' | 'unguarded'`; `interface RealGate { mode: RealGateMode; missing: string[] }`; `READINESS_STALE_MS = 15 * 60_000`.

- [ ] **Step 1: Tests.** En `settings.test.ts`: `it('lossCap por defecto es 1 (apagado)')` → `expect(DEFAULT_SETTINGS.risk.lossCap).toBe(1)`; `it('completa lossCap en ajustes viejos')` → parsear un `DEFAULT_SETTINGS` sin `risk.lossCap` devuelve `lossCap: 1`; `it('rechaza lossCap fuera de 0,1..1')` con `0.05` y `1.2`. En `commands.test.ts`: `real_off` con payload vacío parsea y `isPriceSensitive('real_off') === false`. En `real.test.ts`: `REAL_CHECK_LABELS` tiene una etiqueta no vacía por cada id de `REAL_CHECK_IDS`.
- [ ] **Step 2: Correr y ver que fallan** — `pnpm vitest run packages/shared` → FAIL.
- [ ] **Step 3: Implementar.** Etiquetas exactas de `REAL_CHECK_LABELS`: keys "Claves de operación cargadas", futures_enabled "La clave puede operar futuros", no_withdrawals "La clave no puede hacer retiros", ip_restricted "La clave está restringida por IP", one_way "La cuenta está en modo de una posición por moneda", wallet "La billetera de futuros tiene el capital asignado", clock "La hora de la Mac coincide con la de Binance", multi_assets_off "El modo multi-activos está apagado", fee_burn_off "El descuento de comisiones con BNB está apagado", env_match "La sesión es del mismo entorno (testnet o real)".
- [ ] **Step 4: Correr** — `pnpm vitest run packages/shared` → PASS; `pnpm typecheck` → los `Record<BotPhase,…>`/`Record<CommandKind,…>` que no compilen se completan en las tasks que los dueñan (13 para la web, 12 para `commands.ts`): acá sólo agregar casos `'off'`/`'real_off'` que digan lo mínimo para compilar (`'Apagada'`, `throw new Error('real_off sólo en la sesión real')`).
- [ ] **Step 5: Commit** — `feat(shared): vocabulario de plata real y tope de pérdida`.

---

### Task 2: Esquema, migración y repos *(mecánica, con cuidado en el índice)*

**Files:**
- Modify: `packages/db/src/schema/{enums,sessions,bot,index}.ts`, `packages/db/src/repos/{sessions,errors,index,bot}.ts`; todos los usos de `getActiveLive` (`apps/bot/src/live/runtime.ts`, `apps/web/lib/queries/session.ts`, `apps/web/lib/actions/{commands,session}.ts`)
- Create: `packages/db/src/schema/real.ts`, `packages/db/src/repos/real.ts`, `packages/db/migrations/0006_plata_real.sql` (generada)
- Test: `packages/db/test/repos/sessions.test.ts`, `packages/db/test/repos/real.test.ts`

**Interfaces:**
- Consumes: Task 1 (`BinanceEnv`, `RealStatus`, `RealCheck`, `RealGate`, `REAL_LOSS_CAP_DEFAULT`).
- Produces:
  - `sessions` + `binanceEnv: text().$type<BinanceEnv>()` (null salvo en `live`), `realStatus: realStatus()` (pgEnum de `REAL_STATUSES`, null salvo en `live`), `realOffReason: text().$type<RealOffReason>()`, `realChangedAt: timestamptz()`.
  - Índice `sessions_single_active_idx` reemplazado por `sessions_single_active_per_kind_idx` = unique `(kind)` where `status = 'active'`. `ActiveSessionExistsError` se detecta con el nombre nuevo.
  - `bot_status` + `real: jsonb().$type<RealGate>()` (null en papel).
  - Tabla `real_readiness`: `env` text pk (`BinanceEnv`), `checkedAt` timestamptz, `enabled` boolean, `keysPresent` boolean, `checks` jsonb `RealCheck[]`, `walletAvailable` double nullable, `instanceId` text.
  - Tabla `real_events`: `id` identity, `sessionId` fk cascade, `at` timestamptz, `kind` text (`'rejected' | 'foreign_position' | 'mismatch' | 'reconciled' | 'adopted' | 'unprotected' | 'loss_floor' | 'fatal' | 'off' | 'on'`), `symbol` text null, `phrase` text, `data` jsonb; índice `(session_id, at)`.
  - `sessions.getActive(kind: 'paper_live' | 'live'): Promise<SessionRow | null>` (reemplaza a `getActiveLive`, que se borra).
  - `sessions.createReal({ capitalInicial, lossCap, binanceEnv, by }): Promise<SessionRow>` — `kind 'live'`, nombre "Plata real", `realStatus 'on'`, ajustes `DEFAULT_SETTINGS` con `risk.lossCap = lossCap`, aprendizaje `zero`.
  - `sessions.setRealStatus(id, next: RealStatus, reason: RealOffReason | null): Promise<boolean>` — false si la sesión no es `live` activa o si está en `loss_floor` (terminal).
  - `sessions.archive` rechaza `kind 'live'` con `{ archived: false, reason: 'real_session' }`; `sessions.archiveReal(id): Promise<{ archived: true } | { archived: false; reason: 'still_on' | 'open_positions' | 'not_active' }>` (sólo con `realStatus ≠ 'on'` y sin abiertas).
  - `copyLearning('continued')` busca sólo `kind = 'paper_live'`.
  - `realReadiness.upsert(row)`, `realReadiness.latest(): Promise<RealReadinessRow | null>` (el de `checkedAt` más nuevo); `realEvents.append(sessionId, RealEventInput[])`, `realEvents.list(sessionId, { from, to })`. Ambos en `createRepos`.

- [ ] **Step 1: Tests de repos** (base `_test`, helpers existentes):
  - `it('una activa por tipo: papel y real conviven')` → `createLive` + `createReal` sin error; un segundo `createReal` tira `ActiveSessionExistsError`.
  - `it('crear una simulación no archiva la real')` → con las dos activas, `getActive('paper_live')` devuelve la de papel y archivarla deja la real `active`.
  - `it('archive rechaza la sesión real')` → `reason: 'real_session'`; `archiveReal` con `realStatus 'on'` → `still_on`; con abiertas → `open_positions`.
  - `it('loss_floor es terminal')` → `setRealStatus(id,'loss_floor',null)` true y después `setRealStatus(id,'on',null)` false.
  - `it('continued no copia el aprendizaje de la real')`.
  - `real.test.ts`: `upsert` dos veces el mismo `env` deja una fila; `latest()` trae la más nueva; `append`/`list` por rango.
- [ ] **Step 2: Correr** — `pnpm vitest run packages/db/test/repos/sessions.test.ts packages/db/test/repos/real.test.ts` → FAIL.
- [ ] **Step 3: Esquema y repos** como en Interfaces. Reemplazar cada `getActiveLive()` por `getActive('paper_live')` (el bot del Task 11 agrega el slot real).
- [ ] **Step 4: Migración** — `pnpm --filter @sereno/db db:generate --name plata_real`. Revisar el SQL: `ALTER TYPE … ADD VALUE` para `bot_phase` (`off`) y `command_kind` (`real_off`) sin usar esos valores en la misma migración; `DROP INDEX sessions_single_active_idx` antes del `CREATE UNIQUE INDEX` nuevo.
- [ ] **Step 5: Correr** — `pnpm vitest run packages/db` → PASS (incluye `migrate.test.ts`).
- [ ] **Step 6: Commit** — `feat(db): sesión real, chequeos y eventos de Binance`.

---

### Task 3: Tope de pérdida en el motor *(criterio alto)*

**Files:**
- Create: `packages/core/src/risk/loss-floor.ts`
- Modify: `packages/core/src/types.ts` (`CloseReason` + `'loss_floor'`, `BlockReason` + `'loss_floor'`, `account_rule.rule` + `'loss_floor'`), `packages/core/src/engine/{entries,desk,account-guard,engine,events}.ts`, `packages/core/src/journal/{phrases,wait}.ts`, `apps/web/components/posiciones/format.ts` (etiqueta)
- Test: `packages/core/test/risk/loss-floor.test.ts`, `packages/core/test/engine/engine-loss-floor.test.ts`

**Interfaces:**
- Consumes: `settings.risk.lossCap` (Task 1), `AccountSnapshot`, `Position`, `EntryPlan`.
- Produces:
  - `lossFloor(capitalInicial: number, lossCap: number | undefined): number | null` — `null` salvo que `lossCap < 1` (así un `undefined` o `NaN` de ajustes viejos que el motor recibe sin pasar por zod, como los fixtures de replay, deja la regla apagada).
  - `worstCaseEquity(input: { saldo: number; open: readonly Position[]; plan?: EntryPlan; risk: Pick<Settings['risk'], 'takerFeeRate' | 'slippageRate'> }): number` — `saldo + Σ_open [dir·(stop − entrada)·qty − salida(qty·stop)] + (plan ? −riesgoReal − entrada(notional) − salida(qty·stopPrice) : 0)`, con `salida(n) = n·(takerFeeRate + 2·slippageRate)` (condicional: dos slippages, como el simulador) y `entrada(n) = n·(takerFeeRate + slippageRate)`. El funding no entra (lo dice el comentario).
  - `checkLossFloor(input: { capitalInicial: number; saldo: number; open: readonly Position[]; plan: EntryPlan; settings: Pick<Settings, 'risk'> }): 'loss_floor' | null`.
  - `GuardState.lossFloorHit?: true` (opcional: los estados guardados siguen valiendo); `AccountGuard.noteLossFloor(): boolean` (true la primera vez); con el pestillo puesto `evaluate` devuelve `blocked: 'loss_floor'` antes que cualquier otro corte.
  - `Desk.lossFloorPass(at: number, closed: ClosedPosition[]): Promise<void>` — sólo cartera `real`; si `lossFloor(...) !== null`, la marca está completa y `equity ≤ piso`: pestillo, `tryClose(…, 'loss_floor')` de todas y evento `account_rule` `'loss_floor'` con `data: { capitalInicial, floor, equity, closedCount }`.
  - Frases: cierre "por el tope de pérdida"; espera `loss_floor` "abrirla podía llevarme por debajo del tope de pérdida"; regla "Llegué al tope de pérdida: la cuenta quedó en US$ X y el piso era US$ Y. Cerré todo y me apagué." Etiqueta web `loss_floor: 'Tope de pérdida'`.

- [ ] **Step 1: Tests unitarios** en `loss-floor.test.ts`:
  - `lossFloor(1000, 1)` → `null`; `lossFloor(1000, undefined)` → `null`; `lossFloor(50, 0.5)` → `25`.
  - `worstCaseEquity` con un long abierto `qty 1, entrada 100, stop 95`, `saldo 50`, fee 0,0005 y slippage 0,0002 → `50 − 5 − 95·(0,0005 + 0,0004)`.
  - Un stop ya movido a ganancia suma (no resta) en el peor caso.
  - `checkLossFloor` bloquea cuando el plan nuevo deja el peor caso un centavo bajo el piso y deja pasar uno un centavo arriba.
- [ ] **Step 2: Tests del motor** en `engine-loss-floor.test.ts` con los fixtures de `test/engine/fixtures.ts`:
  - `it('con lossCap 1 no cambia nada')` — misma corrida que un test de entradas existente, mismas decisiones.
  - `it('no abre si el peor caso pasa el piso')` → decisión `blocked` con `reason 'loss_floor'`.
  - `it('al tocar el piso cierra todo y no vuelve a abrir')` → un tick que baja la equity al piso: todas cerradas con `closeReason 'loss_floor'`, un único `account_rule` `'loss_floor'`, y el ciclo siguiente bloquea con `'loss_floor'`.
  - `it('el pestillo sobrevive a snapshot/restore')`.
- [ ] **Step 3: Correr** — `pnpm vitest run packages/core/test/risk/loss-floor.test.ts packages/core/test/engine/engine-loss-floor.test.ts` → FAIL.
- [ ] **Step 4: Implementar.** `checkLossFloor` va en `entries.decide` después de `checkCapacity` (bloqueo `noted`). `lossFloorPass` se llama en `TradingEngine.markTick` después de `shieldPass` y en `runPortfolio` antes de las entradas.
- [ ] **Step 5: Correr todo core** — `pnpm vitest run packages/core` → PASS, con `test/replay/*` y `paper-exchange.test.ts` sin editar.
- [ ] **Step 6: Commit** — `feat(core): tope de pérdida al abrir y en marcha (apagado en papel)`.

---

### Task 4: Interfaz de exchange del motor *(criterio alto)*

**Files:**
- Modify: `packages/core/src/exchange/{types,errors,paper-exchange}.ts`, `packages/core/src/engine/{position-manager,portfolio,types,entries}.ts`, `packages/core/src/types.ts`, `packages/core/src/journal/{phrases,wait}.ts`, `packages/core/src/index.ts`, `packages/core/test/barrel.test.ts`, `apps/web/components/posiciones/format.ts`
- Delete: `packages/core/src/exchange/binance-exchange.ts`, `packages/core/test/exchange/binance-exchange.test.ts`
- Test: `packages/core/test/engine/position-manager-overlap.test.ts`

**Interfaces:**
- Produces:
  - `export type EngineExchange = Exchange & { processTick; applyFunding; setPrices; restorePosition }` (la forma actual) y `export type SimulatedExchange = EngineExchange` (alias, sin churn). `EngineDeps`, `PortfolioDeps`, `PortfolioInit`, `PositionManagerDeps` pasan a `EngineExchange`. El comentario "un exchange real nunca lo implementa" se reescribe.
  - `StopOrder = { symbol; side; stopPrice } & ({ closePosition: true } | { qty: number; reduceOnly: true })`. El simulador trata las dos formas igual (cierra la posición entera: hay una por símbolo). `PositionManager.protect` manda `{ qty: p.qty, reduceOnly: true }`.
  - `Exchange.protectiveOrders?: 'single' | 'overlapping'` (ausente = `'single'`, el simulador no lo declara). Con `'overlapping'`, `PositionManager.moveStop` coloca el nuevo y después cancela el viejo; si el nuevo falla, el viejo queda vivo en `staleStops` (Map símbolo → id), `stopOrderId = null` y `protect` reintenta al nuevo precio y, al lograrlo, cancela el viejo. Con `'single'`, exactamente lo de hoy.
  - `TriggerReason` agrega `'closed_on_exchange' | 'unprotected'`; `CloseReason` agrega los mismos dos. `settle` mapea `'stop'` con `stopCloseReason` como hoy y pasa los demás tal cual.
  - `OrderRejectReason` agrega `'opening_disabled' | 'foreign_position' | 'exchange_rejected'`; `OrderRejectedError` gana `detail?: string` (frase para el diario). `BlockReason` agrega `'opening_disabled' | 'foreign_position' | 'exchange_rejected'` y `REJECTED_AS` los mapea uno a uno.
  - `Fill.reported?: true` (los números vienen del exchange).
  - Frases: cierre `closed_on_exchange` "cerrada en Binance", `unprotected` "no pude poner el stop en Binance: la cerré para no dejarla sin protección"; esperas `opening_disabled` "la operación con plata real está apagada: sólo cuido las abiertas", `foreign_position` "tenés una posición tuya en {moneda}; no la toco", `exchange_rejected` "Binance rechazó la orden". Etiquetas web: "Cerrada en Binance", "Sin stop: cerrada".

- [ ] **Step 1: Test** en `position-manager-overlap.test.ts`, con un doble de `EngineExchange` en el test que registra el orden de llamadas y declara `protectiveOrders: 'overlapping'`:
  - `it('mueve el stop poniendo el nuevo antes de cancelar el viejo')` → llamadas `placeStopMarket(nuevo)` y después `cancelOrder(viejo)`; el pedido lleva `qty` y `reduceOnly: true`.
  - `it('si el nuevo falla, el viejo sigue y se reintenta')` → tras el fallo `cancelOrder` no se llamó; el próximo `protect` coloca el nuevo y recién ahí cancela el viejo.
  - `it('un disparo unprotected cierra con ese motivo')` → `settle` con `reason 'unprotected'` da `closeReason 'unprotected'`.
  - `it('un rechazo foreign_position bloquea con ese motivo')` vía `runEntries`.
- [ ] **Step 2: Correr** — `pnpm vitest run packages/core/test/engine/position-manager-overlap.test.ts` → FAIL.
- [ ] **Step 3: Implementar.** Borrar el stub de core, su test y su línea del barrel (`barrel.test.ts`: sacar `'BinanceFuturesExchange'`).
- [ ] **Step 4: Correr todo** — `pnpm vitest run packages/core apps/bot` y `pnpm typecheck` → PASS; `git diff --stat packages/core/test/replay packages/core/test/exchange/paper-exchange.test.ts` vacío.
- [ ] **Step 5: Commit** — `refactor(core): el motor depende de EngineExchange, no del simulador`.

---

### Task 5: Cliente de órdenes de Binance y Binance falso con órdenes *(criterio alto)*

**Files:**
- Create: `apps/bot/src/binance/{http,trade-rest,trade-types,trade-errors,precision}.ts`, `apps/bot/src/binance/fake/trading.ts`
- Modify: `apps/bot/src/binance/{rest,rate-limiter}.ts`, `apps/bot/src/binance/fake/{server,account}.ts`, `apps/bot/test/helpers/binance.ts`
- Test: `apps/bot/test/binance/{trade-rest,trade-errors,precision,http}.test.ts`, `apps/bot/test/binance/rate-limiter.test.ts`

**Interfaces:**
- Produces:
  - `BinanceHttp` (extraído de `BinanceRest.request`/`signedUrl`/`syncTime`/`backoff`, sin cambiar su conducta para GET): `request<T>(path, params, cost, opts?: { signed?: boolean; method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; retry?: 'safe' | 'never'; priority?: 'normal' | 'high' })`. `retry: 'never'` no reintenta nada (ni red, ni 5xx, ni 429): devuelve el error a quien decide. `BinanceRest` delega en `BinanceHttp`; `test/binance/rest*.test.ts` pasan sin editar.
  - `RateLimiter.acquire(kind, weight, priority?: 'normal' | 'high')` — las `high` se atienden antes que cualquier `normal` en espera.
  - `formatQty(qty: number, stepSize: number): string`, `formatPrice(price: number, tickSize: number): string` (redondeo hacia abajo a la grilla, sin notación exponencial).
  - `BinanceTradeRest` (constructor `{ http: BinanceHttp; sapi: BinanceHttp | null }`; todo firmado, `priority: 'high'`):
    `marketOrder({ symbol, side: 'BUY' | 'SELL', quantity: string, reduceOnly: boolean, clientOrderId }): Promise<OrderAck>` (`newOrderRespType=RESULT`);
    `algoOrder({ symbol, side, type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET', triggerPrice: string, quantity: string, clientAlgoId }): Promise<AlgoAck>` (fija adentro `reduceOnly=true`, `workingType=MARK_PRICE`, nunca `closePosition`);
    `cancelAlgo(symbol, clientAlgoId): Promise<void>` (orden inexistente = éxito);
    `openAlgoOrders(symbol?): Promise<AlgoOrder[]>`; `queryOrder(symbol, clientOrderId): Promise<OrderAck | null>`; `queryAlgo(clientAlgoId): Promise<AlgoOrder | null>`;
    `positionRisk(): Promise<BinancePosition[]>`; `userTrades(symbol, q: { startTime?: number; orderId?: number }): Promise<UserTrade[]>`; `fundingIncome(startTime: number): Promise<IncomeRow[]>`;
    `setIsolated(symbol): Promise<void>` (−4046 "ya está aislado" = éxito); `setLeverage(symbol, leverage): Promise<void>`;
    `dualSide(): Promise<boolean>`; `multiAssets(): Promise<boolean>`; `feeBurn(): Promise<boolean>`; `apiRestrictions(): Promise<ApiRestrictions | null>` (null con `sapi` null: testnet); `usdtBalance(): Promise<{ wallet: number; available: number }>`; `serverTime(): Promise<number>`;
    `listenKeyCreate(): Promise<string>`, `listenKeyKeepAlive(): Promise<void>`, `listenKeyClose(): Promise<void>`.
  - Creación idempotente: `marketOrder`/`algoOrder` usan `retry: 'never'`; ante red caída, timeout, 5xx o −1007 consultan por id de cliente (GET, `retry: 'safe'`): si la orden existe la devuelven; si no, reintentan una sola vez con el mismo id.
  - `classifyBinanceError(err: unknown): { kind: 'retryable' | 'rejected' | 'fatal'; code: number | null; message: string }` — `message` en castellano y sin secrets. Tabla fijada en el test (a verificar en el Step 1): retryable = red, 5xx, 429/418, −1001, −1007, −1015, −1021; rejected = −2019 margen, −4164 nocional mínimo, −2021 dispararía ya, −2022 reduceOnly rechazado, −1111 precisión, −4003/−4005 cantidad, −4131, −2010/−2018 saldo; fatal = −2015, −2014, −1022, 401, 451, −4061 (modo cobertura), −4120 (endpoint equivocado: bug).
  - Tipos crudos y normalizados en `trade-types.ts`: `OrderAck { symbol; orderId; clientOrderId; status; executedQty; avgPrice; updateTime }`, `AlgoAck`, `AlgoOrder { symbol; clientAlgoId; algoId; type; side; triggerPrice; quantity; status }`, `BinancePosition { symbol; amount; entryPrice; markPrice; liquidationPrice; marginType; isolatedMargin; leverage }`, `UserTrade { id; orderId; symbol; side; price; qty; commission; commissionAsset; realizedPnl; time }`, `IncomeRow { symbol; income; time; tranId }`, `ApiRestrictions { enableFutures; enableWithdrawals; ipRestrict }`.
  - `FakeTrading` en `fake/trading.ts`: cuenta one-way con billetera USDT, posiciones por símbolo, libro de algorítmicas que dispara por la marca que empuja el test (`setMark(symbol, price)`), fills a la marca, comisión taker, `realizedPnl`; guiones `rejectNext(path, code, msg)`, `partialFillNext(fraction)`, `dropResponseNext(path)` (la orden entra pero la respuesta se corta), `manualPosition(symbol, amount)` (lo que Toti abre a mano), `config({ dualSide, multiAssets, feeBurn, restrictions, serverTimeOffsetMs })`. Rechaza `STOP_MARKET`/`TAKE_PROFIT_MARKET` en `/fapi/v1/order` con −4120 y `closePosition=true` en algorítmicas. `FakeBinance` gana `trading: FakeTrading`, enruta POST/PUT/DELETE, verifica la firma también en POST/DELETE y sirve `/sapi/v1/account/apiRestrictions` (con `sapiEnabled` apagable para simular testnet).

- [ ] **Step 1: Verificar la documentación vigente de Binance** (WebFetch a `developers.binance.com/docs/derivatives/usds-margined-futures/…`) para: `POST/DELETE /fapi/v1/algoOrder`, `GET /fapi/v1/openAlgoOrders` y consulta individual (nombres exactos: `algoType`, `triggerPrice` o `stopPrice`, `clientAlgoId`, `quantity`, `reduceOnly`, `workingType`, `priceProtect`, estados), largo y regex de `newClientOrderId`/`clientAlgoId`, `POST /fapi/v1/order` (`newOrderRespType`), `GET /fapi/v3/positionRisk` (o la versión vigente), `/fapi/v1/userTrades`, `/fapi/v1/income`, `/fapi/v1/marginType`, `/fapi/v1/leverage`, `/fapi/v1/positionSide/dual`, `/fapi/v1/multiAssetsMargin`, `/fapi/v1/feeBurn`, `/fapi/v3/balance`, `/fapi/v1/listenKey`, `GET /sapi/v1/account/apiRestrictions` (host `api.binance.com`), pesos de cada uno, los códigos de error de la tabla de arriba, y los hosts de testnet (REST `testnet.binancefuture.com` o `demo-fapi.binance.com`, stream de mercado y privado: si existe la ruta `/market/` en testnet). Escribir lo verificado, con URL y fecha de consulta, como comentario de cabecera de `trade-types.ts`, y ajustar los nombres de Interfaces si difieren (los de este plan son los esperados, la documentación manda). **El Binance falso se escribe con exactamente esos nombres de campo.**
- [ ] **Step 2: Tests** (`trade-rest.test.ts`, contra `FakeBinance`):
  - `it('stop por la API algorítmica con reduceOnly, cantidad y MARK_PRICE')` → el pedido registrado tiene esos parámetros y nunca `closePosition`.
  - `it('si la respuesta se corta, no duplica la orden')` → `dropResponseNext('/fapi/v1/order')`: una sola orden en el falso y `marketOrder` devuelve su ack.
  - `it('nunca reintenta un POST a ciegas en 5xx')` → con 503 consulta por id de cliente antes de reintentar.
  - `it('setIsolated acepta −4046')`; `it('apiRestrictions null sin sapi')`.
  - `it('ni la clave ni el secret ni la firma aparecen en errores ni logs')` → forzar −2015 y red caída; `log-sink` y `err.message` no contienen `FAKE_API_KEY`, `FAKE_API_SECRET` ni `signature=`.
  - `trade-errors.test.ts`: una fila por código de la tabla → `kind` esperado y `message` en castellano (p. ej. −2019 → "Binance rechazó la orden: no alcanza el margen").
  - `precision.test.ts`: `formatQty(0.12345, 0.001) === '0.123'`, `formatPrice(64123.456, 0.1) === '64123.4'`, `formatQty(1e-7, 1e-8) === '0.00000010'`.
  - `rate-limiter.test.ts`: `it('las de prioridad alta pasan antes que las normales en espera')`.
- [ ] **Step 3: Correr** — `pnpm vitest run apps/bot/test/binance` → FAIL en los nuevos.
- [ ] **Step 4: Implementar** `http.ts` (extracción), prioridad del limitador, `precision.ts`, `trade-*.ts` y `fake/trading.ts`.
- [ ] **Step 5: Correr** — `pnpm vitest run apps/bot/test/binance` → PASS, con los tests existentes de `rest*.test.ts` sin editar.
- [ ] **Step 6: Commit** — `feat(bot): cliente de órdenes de Binance (algorítmicas) y Binance falso que opera`.

---

### Task 6: User data stream *(criterio alto)*

**Files:**
- Create: `apps/bot/src/binance/user-stream.ts`, `apps/bot/src/binance/fake/user-stream.ts`
- Modify: `apps/bot/src/binance/fake/{server,trading}.ts`, `apps/bot/src/binance/trade-types.ts`
- Test: `apps/bot/test/binance/user-stream.test.ts`

**Interfaces:**
- Consumes: `BinanceTradeRest.listenKey*` (Task 5), `StreamSocketFactory` de `ws.ts`.
- Produces:
  - `class UserDataStream` — `constructor({ trade: Pick<BinanceTradeRest, 'listenKeyCreate' | 'listenKeyKeepAlive' | 'listenKeyClose'>; url: string; WebSocket?; now?; logger?; keepAliveMs?: number /* 30 min */; backoffBaseMs?; backoffMaxMs? })`, `start()`, `stop()`, `on(event, cb)`, `get connected(): boolean`.
  - Eventos: `order: (u: OrderTradeUpdate) => void`, `algo: (u: AlgoUpdate) => void`, `account: (u: AccountUpdate) => void`, `status: (s: 'connected' | 'reconnecting' | 'closed') => void`, `resync: () => void` (después de cada reconexión o `listenKeyExpired`: quien escucha corre la reconciliación REST).
  - Normalizados (campos crudos fijados por la verificación del Task 5): `OrderTradeUpdate { symbol; clientOrderId; orderId; side; origType; status; execType; lastQty; lastPrice; avgPrice; cumQty; commission; commissionAsset; realizedPnl; reduceOnly; at; liquidation: boolean }` (`liquidation` = id de cliente `autoclose-`/`adl_autoclose`), `AlgoUpdate { symbol; clientAlgoId; algoId; status; triggeredOrderId: number | null; at }`, `AccountUpdate { reason; at; positions: { symbol; amount; entryPrice }[] }`.
  - El falso: ruta privada del Step 1 del Task 5; `FakeTrading` empuja `ORDER_TRADE_UPDATE`, `ALGO_UPDATE` (incluido el vínculo con la orden de mercado que nace al disparar) y `ACCOUNT_UPDATE` en cada cambio; `expireListenKey()`, `dropUserClients()`, `holdUserEvents(on)` (los eventos se guardan y salen al soltarlos: simula un stream atrasado).

- [ ] **Step 1: Tests:**
  - `it('un stop que dispara en el falso llega como algo TRIGGERED y order FILLED vinculadas')` → `triggeredOrderId` del algo = `orderId` del order.
  - `it('renueva el listenKey cada 30 minutos')` con reloj falso → `PUT /fapi/v1/listenKey` a los 30 min.
  - `it('reconecta y pide resync tras un corte')` → `dropUserClients()` → `status 'reconnecting'`, después `'connected'` y un `resync`.
  - `it('listenKeyExpired crea otro y pide resync')`.
  - `it('una liquidación se marca liquidation')`.
- [ ] **Step 2: Correr** — `pnpm vitest run apps/bot/test/binance/user-stream.test.ts` → FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Correr** → PASS.
- [ ] **Step 5: Commit** — `feat(bot): user data stream de futuros con reconexión y resync`.

---

### Task 7: Ids de cliente y `RealAccount` *(criterio alto)*

**Files:**
- Create: `apps/bot/src/real/client-id.ts`, `apps/bot/src/real/account.ts`
- Test: `apps/bot/test/real/client-id.test.ts`, `apps/bot/test/real/account.test.ts`

**Interfaces:**
- Consumes: `BinanceTradeRest` (Task 5), `UserDataStream` (Task 6).
- Produces:
  - `sessionShort(sessionId: string): string` — 8 caracteres hex del uuid de `ses_<uuid>`; `type ClientKind = 'o' | 'c' | 's' | 't' | 'x'` (abrir, cerrar, stop, take profit, interruptor); `class ClientIds { constructor(sessionId: string, now: () => number); next(kind: ClientKind): string }` → `sereno-<short>-<kind><base36(now)><base36(seq)>`, ≤ el largo verificado; `parseClientId(id: string): { short: string; kind: ClientKind } | null`.
  - `class RealAccount` — `constructor({ trade: TradeApi; stream: UserStreamLike; sessionId; clock; logger })` donde `TradeApi = Pick<BinanceTradeRest, …>` y `UserStreamLike = Pick<UserDataStream, 'on' | 'start' | 'stop' | 'connected'>`.
    `start(): Promise<void>` (stream + primer `sync`); `stop(): Promise<void>`;
    `sync(): Promise<SyncSnapshot>` — `positionRisk` + `openAlgoOrders` (sólo las del prefijo de la sesión); `SyncSnapshot { at; positions: Map<string, BinancePosition>; botAlgos: AlgoOrder[] }`;
    `position(symbol): BinancePosition | null` (estado vivo: stream + último sync);
    `botAlgos(symbol?): AlgoOrder[]`;
    `awaitOrderFill(symbol, clientOrderId, timeoutMs: number): Promise<OrderFill>` — junta los `ORDER_TRADE_UPDATE` de esa orden hasta `FILLED`/`EXPIRED`/`CANCELED`; vencido el plazo, completa con `userTrades({ orderId })`. `OrderFill { clientOrderId; qty; avgPrice; commission; realizedPnl; at; status }` (comisión en USDT; otra moneda es un error `fatal`, porque `feeBurn` está apagado);
    `onTriggered(cb: (t: { symbol; clientAlgoId; fill: OrderFill; liquidation: boolean }) => void)` — un fill de una orden que nació de un algo del bot (por `triggeredOrderId`) o una liquidación de un símbolo con algo del bot;
    `onResync(cb)`; `get streamUp(): boolean`.

- [ ] **Step 1: Tests** (`client-id.test.ts`): ida y vuelta `parseClientId(ids.next('s'))`; dos `next` seguidos distintos; largo ≤ 36; `parseClientId('autoclose-123')` y `parseClientId('sereno-otraaaaa-s1')` (otra sesión) → null para la sesión. (`account.test.ts`, contra el falso): `sync` ignora algos sin prefijo; `awaitOrderFill` arma el fill con dos parciales (`partialFillNext(0.5)` + resto) y precio promedio ponderado; con `holdUserEvents(true)` completa por `userTrades` al vencer el plazo; `onTriggered` llega con la comisión y el pnl realizado del falso.
- [ ] **Step 2: Correr** — `pnpm vitest run apps/bot/test/real` → FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Correr** → PASS.
- [ ] **Step 5: Commit** — `feat(bot): cuenta real sobre REST y user data stream`.

---

### Task 8: `BinanceFuturesExchange`, el adaptador real *(criterio alto: el corazón del riesgo)*

**Files:**
- Create: `apps/bot/src/real/exchange.ts`
- Test: `apps/bot/test/real/exchange.test.ts`

**Interfaces:**
- Consumes: `EngineExchange`, `StopOrder`, `OrderRejectedError` (Task 4); `RealAccount`, `ClientIds` (Task 7); `BinanceTradeRest`, `classifyBinanceError`, `formatQty/formatPrice` (Task 5).
- Produces:
  - `class BinanceFuturesExchange implements EngineExchange` con `readonly protectiveOrders = 'overlapping'`; `constructor({ account: RealAccount; trade: TradeApi; ids: ClientIds; infos: Record<string, SymbolInfo>; clock; initialBalance: number; openings: () => OpeningsGate; onNote: (note: RealNote) => void; retry?: { delaysMs: number[] /* [0, 500, 1500] */; fillTimeoutMs: number /* 3000 */ } })`.
  - `type OpeningsGate = { allowed: true } | { allowed: false; detail: string }` (lo decide el gating del Task 10; el adaptador sólo lo consulta).
  - `type RealNote = { kind: 'rejected' | 'foreign_position' | 'mismatch' | 'unprotected' | 'fatal'; symbol: string | null; phrase: string; data?: unknown }` (va a `real_events` en el Task 11).
  - Métodos extra (para Tasks 9 y 12): `queueClose(symbol: string, close: PendingClose): void` con `PendingClose { reason: TriggerReason; fill: OrderFill; triggerPrice: number }`; `queueFunding(applied: FundingApplied): void`; `ensureProtected(symbol: string): Promise<void>`; `cancelAllBot(): Promise<void>`; `lastStop(symbol): { price: number; qty: number } | null`.
- Reglas (cada una con su test):
  - `setLeverage`: primero el gating de aperturas (`opening_disabled` con `detail`), después propiedad: si Binance tiene posición en el símbolo y el bot no → `foreign_position` con "tenés una posición tuya en {moneda}; no la toco"; si el símbolo está marcado con diferencia de cantidad → `foreign_position`. Recién entonces `setIsolated` y `setLeverage` en Binance; un rechazo → `exchange_rejected` con el `message` clasificado. Todo rechazo de Binance (acá, al abrir o al proteger) también sale por `onNote` con `kind 'rejected'` y esa frase.
  - `placeMarketOrder` (abrir, `reduceOnly` falso): id `o`, `formatQty`, `awaitOrderFill`; cantidad ejecutada 0 → `exchange_rejected`; parcial → la posición es lo ejecutado. Fill con `reported: true`, precio promedio, comisión y pnl de Binance, `spreadCost: 0`, `slippageCost = max(0, dir·(promedio − último precio al mandar))·qty`. La billetera de la sesión (`initialBalance` + realizados − comisiones + funding, todo de Binance) es la de `getBalance`; `available = total − margen en uso`; si no alcanza para margen + comisión estimada → `insufficient_margin` antes de mandar.
  - `placeStopMarket`/`placeTakeProfitMarket`: si ya hay un algo del bot del mismo tipo en el símbolo con el mismo `triggerPrice` en la grilla y la misma cantidad, devuelve ese id (así reiniciar no duplica); si hay uno del mismo tipo con otro precio o cantidad (quedó de antes de un reinicio), después de poner el nuevo se cancela. Si no, id `s`/`t`, cantidad = la del bot (nunca la de Binance si difiere), reintentos `delaysMs` para `retryable`; −2021 tira enseguida (el respaldo por tick cierra). Si el **stop** falla después de los reintentos: cierra a mercado (id `c`, `reduceOnly`), encola `PendingClose` con `reason 'unprotected'`, nota `unprotected` y tira. El id que ve el motor es el `clientAlgoId`.
  - `cancelOrder`: `cancelAlgo`; inexistente = éxito.
  - `closePosition(symbol)`: si hay un `PendingClose` encolado del símbolo, lo consume y devuelve su fill. Si no, `reduceOnly` MARKET por la cantidad del bot (id `c`); con −2022 (ya no hay posición: disparó el stop) espera hasta `fillTimeoutMs` el disparo y devuelve ese fill; los parciales se acumulan hasta llegar a cero (se reintenta en la próxima llamada si queda resto) y el fill devuelto es el agregado. Después cancela los algos hermanos del bot.
  - `processTick(tick)`: `setPrices` y entrega los `PendingClose` del símbolo como `TriggeredOrder` (`pnlGross` = Σ realizedPnl, `realized` = Σ realizedPnl − Σ comisión, `shortfall 0`, liquidación con `orderId null`). `account.onTriggered` alimenta la cola (`reason` `stop`/`take_profit` según el algo, `liquidation` si corresponde).
  - `applyFunding(ev)`: entrega lo encolado por `queueFunding` para `ev.symbol` (el monto es el de Binance; la tasa del evento sólo valida).
  - `restorePosition(state)`: registra la cantidad del bot; si Binance tiene otra cantidad del mismo lado → marca diferencia y nota `mismatch`; `liquidationRecalculated` con la liquidación de Binance si difiere en más de un tick.
  - Un error `fatal` en cualquier método → nota `fatal` y tira.

- [ ] **Step 1: Tests** contra el falso (`FakeTrading`) y un reloj manual:
  - `it('abre aislado con el apalancamiento del plan y deja stop y TP algorítmicos')`.
  - `it('con la operación apagada no toca Binance')` → `openings: () => ({ allowed: false, … })`: `setLeverage` tira `OrderRejectedError('opening_disabled')` y el falso no registró pedidos.
  - `it('no abre donde Toti tiene posición')` → `manualPosition('SOLUSDT', 3)`: `foreign_position`, detalle "tenés una posición tuya en SOL; no la toco".
  - `it('fill parcial: la posición es lo ejecutado')` y `it('cierre parcial se completa en el próximo intento con fill agregado')`.
  - `it('cierre pedido con el stop ya disparado devuelve el fill del stop')` → mover la marca del falso más allá del stop con `holdUserEvents(true)`, llamar `closePosition`, soltar eventos: un solo fill, el del stop; el falso no recibió una orden `c` que haya ejecutado.
  - `it('con cantidad distinta cierra sólo la del bot')` → el bot tiene 1, Toti suma 2: `closePosition` manda `quantity 1` y la posición de Binance queda en 2; stops por 1.
  - `it('stop imposible: cierra a mercado y avisa unprotected')` → `rejectNext('/fapi/v1/algoOrder', -1001)` tres veces: posición cerrada en el falso, nota `unprotected` y el próximo `processTick` entrega `reason 'unprotected'`.
  - `it('placeStopMarket reutiliza un stop igual ya puesto')`.
  - `it('los números del fill son los de Binance')` → comisión y pnl iguales a los del falso, `reported: true`.
- [ ] **Step 2: Correr** — `pnpm vitest run apps/bot/test/real/exchange.test.ts` → FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Correr** → PASS. Además un test que arma un `TradingEngine` sobre este adaptador (sin sombra) y corre un ciclo con entrada: el motor abre, protege y cierra por TP sin saber que es real.
- [ ] **Step 5: Commit** — `feat(bot): exchange real de Binance con stops algorítmicos y propiedad por moneda`.

---

### Task 9: Reconciliación, adopción y funding real *(criterio alto)*

**Files:**
- Create: `apps/bot/src/real/{reconcile,funding}.ts`
- Modify: `packages/db/src/repos/positions.ts` (`insertAdopted`)
- Test: `apps/bot/test/real/reconcile.test.ts`, `apps/bot/test/real/funding.test.ts`

**Interfaces:**
- Consumes: `RealAccount`, `BinanceFuturesExchange.queueClose/queueFunding/ensureProtected/lastStop` (Task 8), repos (Task 2).
- Produces:
  - `reconcileAtStart(deps: { repos; account: RealAccount; trade: TradeApi; sessionId; infos; atr1h: (symbol: string) => Promise<number | null>; settings: Settings; now }): Promise<StartReconcile>` (`atr1h` sale de velas de 1h por REST con `atr` de core: al arrancar todavía no hay calentamiento; con `null`, el stop va a 2% de la entrada) — corre **antes** de armar el motor. `StartReconcile { pendingCloses: Map<string, PendingClose>; adopted: string[]; foreign: string[]; notes: RealNote[] }`:
    - abierta en la base y sin posición en Binance → busca los trades de cierre (`userTrades` desde `openedAt`); motivo por el id de cliente (`s` → stop, `t` → take_profit, `x` → close_all, liquidación → liquidation, lo demás → `closed_on_exchange`); el motor la cierra al restaurar y recibir el primer tick;
    - posición en Binance que la base no conoce → se adopta **sólo** si hay un fill `o` de la sesión que la explique (precio y cantidad de ese fill): `repos.positions.insertAdopted(sessionId, row)` con stop a `k·ATR(1h)` del precio de entrada, `openReason` "La adopté de Binance: me caí entre la orden y el guardado.", nota `adopted`; si no, nota `foreign_position` y la moneda queda bloqueada.
  - `class Reconciler` — `constructor({ account; exchange: BinanceFuturesExchange; trade; repos; sessionId; clock; onNote })`, `tick(): Promise<void>`, `intervalMs(): number` (60_000; 10_000 con `!account.streamUp`). Por tick: `sync`; abierta del bot sin stop vivo en Binance → `ensureProtected` (repone `lastStop`; si no puede, el adaptador cierra como `unprotected`); posición del bot que desapareció sin evento → `queueClose` con el fill de `userTrades`; algos del bot huérfanos (sin posición del bot) → cancelar; cada diferencia → nota `reconciled` con la frase "Binance y yo no coincidíamos en {moneda}: {qué}. Lo corregí."
  - `class FundingCollector` — `constructor({ trade; exchange; account; clock; since: number })`, `collect(): Promise<FundingApplied[]>` (`fundingIncome` desde lo último visto, por `tranId`; reparte por cantidad del bot / cantidad en Binance), `onFunding(cb)` — lo llama el Reconciler y cada `ACCOUNT_UPDATE` con `reason 'FUNDING_FEE'`.

- [ ] **Step 1: Tests** (falso + base de prueba del bot):
  - `it('reiniciar no duplica stops')` → abrir, tirar el motor y la cuenta, `reconcileAtStart` + motor nuevo + un tick: el falso tiene exactamente un algo STOP y uno TP del bot en el símbolo.
  - `it('cerrada por el stop con el bot apagado: cierre con el fill real y motivo stop')`.
  - `it('posición sin rastro en la base pero con fill o: se adopta con stop')` y `it('posición sin fill del bot: es de Toti y no se toca')`.
  - `it('stop cancelado a mano en Binance: lo repone en el próximo tick')`.
  - `it('con el stream caído reconcilia cada 10 s')`.
  - `funding.test.ts`: `it('cobra el funding que informa Binance, una sola vez por tranId')`; `it('con cantidad de Toti en la moneda reparte por la del bot')`.
- [ ] **Step 2: Correr** — `pnpm vitest run apps/bot/test/real/reconcile.test.ts apps/bot/test/real/funding.test.ts` → FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Correr** → PASS.
- [ ] **Step 5: Commit** — `feat(bot): reconciliación con Binance, adopción y funding real`.

---

### Task 10: Configuración, chequeos y gating *(criterio medio)*

**Files:**
- Modify: `apps/bot/src/config.ts`, `.env.example`
- Create: `apps/bot/src/real/{checks,gate,readiness}.ts`
- Test: `apps/bot/test/config.test.ts`, `apps/bot/test/real/{checks,gate,readiness}.test.ts`

**Interfaces:**
- Consumes: Task 1 (`RealCheck`, `RealGate`), Task 2 (`realReadiness` repo), Task 5 (`BinanceTradeRest`, hosts verificados).
- Produces:
  - `BotConfig.real: { enabled: boolean; env: BinanceEnv; apiKey: string | null; apiSecret: string | null; restUrl: string; sapiUrl: string | null; marketWsUrl: string; userWsUrl: string }`. `enabled` sólo con `SERENO_REAL_TRADING === 'on'`. `BINANCE_ENV` ausente → `'testnet'`; otro valor → error de configuración que nombra la variable. Hosts por entorno como constantes (`REAL_HOSTS: Record<BinanceEnv, …>`), los del Step 1 del Task 5. `.env.example` documenta las cuatro variables sin valores.
  - `runRealChecks(deps: { trade: TradeApi; env: BinanceEnv; keysPresent: boolean; capital: number | null; sessionEnv: BinanceEnv | null; now: () => number }): Promise<RealCheck[]>` — uno por `REAL_CHECK_IDS`, en ese orden; sin claves todos menos `keys` quedan `skipped`. En testnet `no_withdrawals`, `ip_restricted`, `futures_enabled` y `fee_burn_off` quedan `skipped` con "En testnet no existe: lo salteo." `clock` falla con `|serverTime − now| ≥ 1000`. `wallet` usa `available ≥ capital` (con `capital` null: `skipped`). Un error de Binance en un chequeo → `fail` con el `message` clasificado.
  - `decideGate(input: { enabled: boolean; keysPresent: boolean; env: BinanceEnv; checks: readonly RealCheck[]; session: { realStatus: RealStatus; binanceEnv: BinanceEnv } }): RealGate` (pura), en este orden: sin claves → `unguarded`, `missing ['las claves de operación']`; `session.binanceEnv ≠ env` → `unguarded`, `missing ['el entorno: la sesión es de {testnet|real}']`; sin `enabled` → `reduce_only`, `missing ['SERENO_REAL_TRADING=on']`; `realStatus 'off'` → `reduce_only`, `missing ['prenderla en Ajustes']`; `'loss_floor'` → `reduce_only`, `missing ['una sesión nueva (tocó el tope de pérdida)']`; algún chequeo `fail` → `reduce_only` con sus etiquetas; si no, `trading` con `missing []`.
  - `class ReadinessWriter` — `constructor({ repos; trade; config; instanceId; clock; capital: () => number | null; sessionEnv: () => BinanceEnv | null })`, `run(): Promise<RealCheck[]>`; corre al arrancar y cada 5 min, y hace `realReadiness.upsert`. Con las claves ausentes igual escribe la fila (así el dashboard dice qué falta).

- [ ] **Step 1: Tests:**
  - `config.test.ts`: sin `BINANCE_ENV` → `testnet`; `BINANCE_ENV=prod` → tira nombrando `BINANCE_ENV`; `SERENO_REAL_TRADING=ON` y `=1` → `enabled false`.
  - `gate.test.ts`: tabla con un caso por regla y su `missing` exacto; `it('sin la variable pero con claves: reduce_only, nunca unguarded')`.
  - `checks.test.ts` contra el falso: retiros habilitados → `no_withdrawals fail`; `dualSide true` → `one_way fail`; `serverTimeOffsetMs 1500` → `clock fail`; `multiAssets true` → `fail`; `sapiEnabled false` en testnet → los cuatro `skipped`.
  - `readiness.test.ts`: escribe la fila sin claves con `keysPresent false` y `checks[0].status 'fail'`.
- [ ] **Step 2: Correr** — `pnpm vitest run apps/bot/test/config.test.ts apps/bot/test/real` → FAIL en los nuevos.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Correr** → PASS.
- [ ] **Step 5: Commit** — `feat(bot): llaves, chequeos al arrancar y gating de la sesión real`.

---

### Task 11: Dos sesiones en un proceso *(criterio alto)*

**Files:**
- Create: `apps/bot/src/live/{slot,market-stack}.ts`, `apps/bot/src/real/{kit,controller,universe}.ts`
- Modify: `apps/bot/src/live/{runtime,session,engine-build,session-load,heartbeat,main}.ts`, `apps/bot/src/binance/ws.ts` (sólo si testnet no tiene la ruta `/market/`: opción `requireMarketRoute`)
- Test: `apps/bot/test/live/{market-stack,two-sessions}.test.ts`, `apps/bot/test/real/controller.test.ts`

**Interfaces:**
- Consumes: todo lo anterior.
- Produces:
  - `class MarketStack` — `constructor({ rest: LiveRest; streamFactory; clock; logger; repos; persistCandles: boolean })`; expone `market`, `gate`, `funding`, `spreads`, `feed(consumerId: string): MarketFeed`, `onMark(cb)`, `onReconnecting(cb)`, `stop()`. `feed(id).keepOnly(symbols)` nunca saca símbolos que pide otro consumidor (unión por consumidor). Con `persistCandles false` no lee ni escribe `candles` (warmup sólo por REST). El runtime actual pasa a usarlo sin cambiar conducta.
  - `class SessionSlot` — lo que hoy hace `Runtime` con una sesión (descubrir la activa, lease, `keep`, `retire`, latido, reintento al minuto), parametrizado por `kind: 'paper_live' | 'live'` y una `open(row): Promise<SlotSession>`; errores y `RecentErrors` propios por slot. `Runtime` tiene dos slots; uno que falla nunca frena al otro.
  - `interface SessionPolicy { kind: 'paper' | 'real'; pollFutures: boolean; sampleSpreads: boolean; persistCandles: boolean; cleanup: boolean; afterGap: 'engine_reconcile' | 'mark_ticks' }`. Papel = lo de hoy (`true, true, true, true, 'engine_reconcile'`). Real = `false, false, false, false, 'mark_ticks'`: lee los datos de futuros que guarda la de papel (`loadFuturesSnapshots`), y después de un hueco entrega `onMarkTick` (Binance ya resolvió los stops: nada de `stop_missed_offline`). `LiveSession` recibe `policy` y `buildEngine: (b: EngineBuild) => Promise<TradingEngine>`.
  - `buildRealKit(deps): Promise<RealKit>` en `real/kit.ts`: `BinanceTradeRest` (en mainnet con el **mismo** `RateLimiter` que el `BinanceRest` de papel; en testnet con uno propio), `UserDataStream`, `RealAccount`, `ClientIds`, `Reconciler`, `FundingCollector`, `ReadinessWriter`; `RealKit.exchange` es el adaptador del motor vigente. `RealKit.buildEngine(b)` arma `TradingEngine` **sin sombra** sobre un `BinanceFuturesExchange` nuevo que comparte la `RealAccount` del kit (así rehacer el motor por ajustes no pierde estado de Binance), con `initialBalance = plan.real.saldo` y `openings` = el último `decideGate(...).mode === 'trading'`.
  - Arranque del slot real: `RealAccount.start` → `reconcileAtStart` → `loadSession` (con lo adoptado ya en la base) → `queueClose` de los pendientes → precios por REST como `onMarkTick`. Con `gate.mode === 'unguarded'` no arma motor: latido con `phase 'off'` y `bot_status.real = gate`.
  - `real/universe.ts`: mainnet = el mismo universo que papel (`refreshUniverse`); testnet = `refreshUniverse` contra mainnet (volúmenes y catálogo compartidos) ∩ símbolos de `exchangeInfo` de testnet, con `stepSize/tickSize/minNotional` de testnet en memoria (nunca escribe `symbols`).
  - `class RealController` — `constructor({ repos; sessionId; kit; lane: EngineLane; clock; logger })`; escucha los eventos del motor y las notas del adaptador: `account_rule 'loss_floor'` → en el mismo lote `setRealStatus('loss_floor')`, `kit.exchange.cancelAllBot()` y `real_events 'loss_floor'`; nota `fatal` → `engine.closeAll('close_all')`, `setRealStatus('off','fatal')`, evento `fatal`; cada `RealNote` → `realEvents.append`. Lee `realStatus` cada 3 s (con los comandos) y recalcula el gate.
  - `heartbeatInput` gana `real: RealGate | null`; la fase `'off'` cuando la sesión real no tiene motor.

- [ ] **Step 1: Tests:**
  - `market-stack.test.ts`: `it('keepOnly de la real no saca las monedas de la de papel')`; `it('sin persistCandles no escribe velas')`.
  - `two-sessions.test.ts` (falso mainnet + falso testnet, base de prueba): `it('papel y real corren en el mismo proceso con leases separados')` → dos filas de `bot_lease` con el mismo `instanceId`; `it('un testnet que contesta 500 siempre no frena la de papel')` → la de papel sigue cerrando ciclos; `it('en mainnet comparten un solo stream de mercado')` → una sola conexión `/market/` al falso; `it('las órdenes de la real pasan antes que el calentamiento de papel')` (limitador compartido con prioridad).
  - `controller.test.ts`: `it('al tocar el tope queda apagada por el tope de pérdida')` → `realStatus 'loss_floor'`, ningún algo del bot en el falso, evento en `real_events`; `it('un -2015 la apaga cerrando lo que puede')`.
- [ ] **Step 2: Correr** — `pnpm vitest run apps/bot/test/live apps/bot/test/real` → FAIL en los nuevos.
- [ ] **Step 3: Implementar** extrayendo primero `MarketStack` y `SessionSlot` con los tests actuales de `test/live/runtime*.test.ts` en verde, y recién después el slot real.
- [ ] **Step 4: Correr** — `pnpm vitest run apps/bot` → PASS.
- [ ] **Step 5: Commit** — `feat(bot): la sesión real corre junto a la de papel`.

---

### Task 12: Interruptor: comando `real_off` y `pnpm bot real-off` *(criterio medio)*

**Files:**
- Create: `apps/bot/src/real/real-off.ts`
- Modify: `apps/bot/src/live/commands.ts`, `apps/bot/src/index.ts`
- Test: `apps/bot/test/real/real-off.test.ts`, `apps/bot/test/live/commands-real.test.ts`

**Interfaces:**
- Consumes: `real_off` (Task 1), `setRealStatus` (Task 2), `BinanceTradeRest`, `ClientIds`, `parseClientId` (Tasks 5 y 7), `RealKit` (Task 11).
- Produces:
  - En `commands.ts`: `real_off` en la sesión real → `engine.closeAll('close_all')`, `kit.exchange.cancelAllBot()`, y en la misma transacción `setRealStatus(id,'off','user')` + `real_events 'off'`. Resultado: "Cerré todo y apagué la operación con plata real." o "Cerré N de M; las demás las reintento con el próximo precio. La operación quedó apagada." En la sesión de papel: `{ ok: false, message: 'Esta simulación no opera con plata real.' }`. `CommandDeps` gana `real?: { kit: RealKit }`.
  - `runRealOffCli(args: string[], deps?: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch; db?: Db; stdout?; stderr? }): Promise<number>`: no requiere `SERENO_REAL_TRADING`; sí las claves (sin ellas: "Faltan BINANCE_TRADE_API_KEY y BINANCE_TRADE_API_SECRET: no puedo hablar con Binance." y código 2). Toma la sesión `live` activa (sin ella: "No hay una sesión con plata real activa." código 0); `setRealStatus(id,'off','user')` **primero** (así el bot, si está vivo, deja de abrir); cancela todos los algos con el prefijo; por cada abierta del bot en la base manda `reduceOnly` MARKET (id `x`) por `min(cantidad del bot, |cantidad en Binance|)`; imprime una línea por moneda y un resumen; código 0 si quedó todo cerrado, 1 si algo falló. No escribe posiciones: las cierra la reconciliación (motivo `close_all` por el id `x`).
  - `index.ts`: comando `real-off` → `process.exitCode = await runRealOffCli(args)`; el mensaje de comando desconocido lista `live`, `replay` y `real-off`.

- [ ] **Step 1: Tests:**
  - `real-off.test.ts` (falso + base): `it('cierra sólo la cantidad del bot')` → bot 1 + Toti 2 en SOL: queda 2; `it('no toca una moneda que es de Toti')`; `it('cancela los stops y take profit del prefijo y ninguno ajeno')`; `it('sin claves sale con 2 y no toca la base')`; `it('deja la sesión apagada aunque Binance falle')` → `realStatus 'off'` y código 1.
  - `commands-real.test.ts`: `it('real_off cierra, cancela y apaga en un lote')`; `it('real_off no vence')` → un comando de hace 2 horas se ejecuta.
- [ ] **Step 2: Correr** — `pnpm vitest run apps/bot/test/real/real-off.test.ts apps/bot/test/live/commands-real.test.ts` → FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Correr** → PASS; `pnpm vitest run apps/bot/test/bin` sigue verde (el supervisor ya corre una vez todo lo que no es `live`).
- [ ] **Step 5: Commit** — `feat(bot): cerrar todo y apagar, por comando y por CLI`.

---

### Task 13: Dashboard: selector de sesión y marca "Plata real" *(mecánica)*

**Files:**
- Create: `apps/web/components/nav/session-switch.tsx`
- Modify: `apps/web/lib/queries/session.ts`, `apps/web/lib/actions/{session,commands,results}.ts`, `apps/web/app/(app)/layout.tsx`, `apps/web/app/s/[sessionId]/layout.tsx`, `apps/web/components/shell/app-shell.tsx`, `apps/web/components/nav/{top-bar,mobile-header,session-chip,session-labels}.tsx`, `apps/web/components/ui/chip.tsx`, `apps/web/components/status/bot-status.ts`, `apps/web/components/ajustes/ajustes-screen.tsx`
- Test: `apps/web/test/nav/session-switch.test.tsx`, `apps/web/test/lib/actions.test.ts`, `apps/web/test/nav/shell.test.tsx`

**Interfaces:**
- Consumes: `getActive(kind)` (Task 2), fase `'off'` (Task 1).
- Produces:
  - `getActiveSessions(): Promise<{ paper: SessionView | null; real: SessionView | null }>` (cacheada). `getContext()` sin id = la de papel activa; la real vive en `/s/<id>` como cualquier otra (`isActive` true, sin banda de contexto).
  - `AppShell` gana `switcher: { paperHref: string; realHref: string | null; current: 'paper' | 'real' | 'other' }`; `SessionSwitch` (segmento "Simulación" / "Plata real", con el `Segment` existente) en `TopBar` y `MobileHeader`, sólo si hay una sesión real activa; cambiar conserva la pestaña (`tabHref`).
  - `ChipTone` gana `'alert'` (con el token de alerta de spec §11.2); `sessionChipLabel` de `kind 'live'` → "Plata real" con tono `'alert'`.
  - `s/[sessionId]/layout.tsx` exporta `generateMetadata`: con `kind 'live'` → `title: { default: 'Plata real · Sereno', template: '%s · Plata real · Sereno' }`.
  - Fase `'off'` en el estado del bot: "Apagada" (y en la sesión real, el `missing` del gate: "apagada: falta X").
  - `createSession`, `archiveSession`, `cancelCommand` usan la de papel; `archiveSession` de una `live` → `failure('real_session', 'La sesión con plata real se apaga desde Ajustes › Plata real.')`. En la sesión real, Ajustes no muestra `BotSection` (nueva/archivar) ni el viejo `RealModeSection`.

- [ ] **Step 1: Tests:**
  - `session-switch.test.tsx`: sin real activa no hay selector; con real activa, en `/posiciones` el enlace "Plata real" va a `/s/<id>/posiciones` y "Simulación" a `/posiciones`; en la real el chip dice "Plata real".
  - `actions.test.ts`: `it('Nueva simulación con una real activa archiva sólo la de papel')`; `it('archivar una sesión real devuelve real_session')`.
  - `shell.test.tsx`: el título de una sesión real es "Plata real · Sereno".
- [ ] **Step 2: Correr** — `pnpm vitest run apps/web/test/nav apps/web/test/lib/actions.test.ts` → FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Correr** — `pnpm vitest run apps/web` y `pnpm --filter @sereno/web typecheck` → PASS.
- [ ] **Step 5: Commit** — `feat(web): selector de sesión y marca de plata real`.

---

### Task 14: Ajustes › Plata real *(criterio medio)*

**Files:**
- Create: `apps/web/lib/queries/real.ts`, `apps/web/lib/actions/real.ts`, `apps/web/components/ajustes/real-section.tsx`
- Delete: `apps/web/components/ajustes/real-mode-section.tsx`
- Modify: `apps/web/components/ajustes/ajustes-screen.tsx`, `apps/web/app/(app)/ajustes/page.tsx`, `apps/web/app/s/[sessionId]/ajustes/page.tsx`
- Test: `apps/web/test/ajustes/real-section.test.tsx`, `apps/web/test/lib/real-actions.test.ts`

**Interfaces:**
- Consumes: `realReadiness.latest`, `sessions.createReal/setRealStatus/archiveReal`, `bot_status.real` (Task 2); `REAL_CHECK_LABELS`, `READINESS_STALE_MS`, `REAL_LOSS_CAP_DEFAULT` (Task 1); `enqueueCommand` existente.
- Produces:
  - `getRealPanel(): Promise<RealPanel>` — `RealPanel { readiness: { env: BinanceEnv; enabled: boolean; keysPresent: boolean; checks: RealCheck[]; checkedAt: number; stale: boolean } | null; session: { id; status: RealStatus; capital: number; lossCap: number; env: BinanceEnv; gate: RealGate | null } | null; canCreate: { ok: true } | { ok: false; missing: string[] } }`. `canCreate` exige readiness fresca, `enabled`, claves y ningún chequeo `fail`, y que no haya una real activa con `realStatus 'on'`.
  - `createRealSession({ capital: number; lossCap: number; confirmation: string }): Promise<{ ok: true; sessionId } | Failure<'invalid' | 'not_ready' | 'confirmation' | 'active_exists'>>` — `capital` en `[5, 100000]`, `lossCap` en `[0.1, 1]`, `confirmation` parseada en es-AR igual a `capital`; si hay una real previa en `off`/`loss_floor` sin abiertas la archiva en la misma transacción; el entorno sale de `readiness.env` (la web nunca lee `BINANCE_ENV`).
  - `turnRealOff({ id: uuid; sessionId })` → `setRealStatus(off, user)` ya mismo + encola `real_off`; `turnRealOn({ sessionId; confirmation })` sólo desde `off`, con `canCreate`-equivalente en verde y la confirmación igual al capital.
  - El tope se edita con `updateSettings` existente (`risk.lossCap`), limitado a `[0.1, 1]` en la UI.
  - `RealSection` (en la sesión de papel: estado y crear; en la real: estado, tope, prender/apagar, "Cerrar todo y apagar"):
    - lista de chequeos con su estado; con readiness vieja: "Hace más de 15 minutos que el bot no revisa: los chequeos pueden estar viejos.";
    - en testnet un chip "Testnet"; en mainnet "Binance real";
    - botón "Empezar con plata real" apagado mientras `canCreate` no esté en verde, con "Para prenderlo falta: …";
    - confirmación: "Escribí {monto} para confirmar que vas a operar con US$ {monto} de verdad.";
    - "Cerrar todo y apagar" con `Confirm` ("Cierro todas las posiciones del bot a mercado, cancelo sus órdenes y dejo de operar. Las tuyas no las toco.");
    - con `gate.mode 'unguarded'` y sin claves, en rojo: "El bot no puede hablar con Binance: lo único que protege tus posiciones son los stops y take profit que ya están puestos allá.";
    - aviso fijo del tope: "El tope se cuida con stops. Si el precio salta de golpe más allá de un stop, la pérdida puede pasar un poco el tope; el margen aislado la limita a lo que puso cada posición.";
    - con `loss_floor`: "Apagada por el tope de pérdida. Para seguir, empezá una sesión nueva con un capital nuevo."

- [ ] **Step 1: Tests:**
  - `real-section.test.tsx`: con un chequeo en `fail` el botón está apagado y lista la etiqueta; con readiness vieja aparece el aviso; la confirmación con "40" para capital 50 no habilita; "Cerrar todo y apagar" llama a `turnRealOff`.
  - `real-actions.test.ts` (base de prueba web existente): `it('no crea sin readiness fresca')`, `it('no crea si la confirmación no es el monto')`, `it('crea con el entorno de la readiness')`, `it('no se puede prender después del tope')`.
- [ ] **Step 2: Correr** — `pnpm vitest run apps/web/test/ajustes/real-section.test.tsx apps/web/test/lib/real-actions.test.ts` → FAIL.
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Correr** — `pnpm vitest run apps/web` → PASS.
- [ ] **Step 5: Commit** — `feat(web): Ajustes › Plata real con chequeos, confirmación e interruptor`.

---

### Task 15: Diario: números de Binance y diferencias *(mecánica)*

**Files:**
- Modify: `apps/bot/src/live/payloads.ts`, `apps/web/lib/queries/journal.ts`, `apps/web/components/resumen/{journal-entry,journal-text}.tsx`
- Test: `apps/bot/test/live/persist.test.ts`, `apps/web/test/resumen/textos.test.ts`

**Interfaces:**
- Consumes: `Fill.reported` (Task 4), `real_events` (Task 2).
- Produces: payloads `open`/`close`/`funding` con `reported: true` cuando el fill o el funding vienen de Binance; `JournalKind` gana `'real'`; las filas de `real_events` del tramo entran al diario con su `phrase` (destacadas: `unprotected`, `loss_floor`, `fatal`, `foreign_position`, `reconciled`); las entradas con `reported` agregan " · datos de Binance".

- [ ] **Step 1: Tests:** persistir un cierre con `reported` deja `payload.reported === true`; el diario de una sesión real muestra "Cerré BTC … · datos de Binance" y la frase de una diferencia de reconciliación destacada; una sesión de papel no cambia.
- [ ] **Step 2: Correr** → FAIL. **Step 3: Implementar.** **Step 4: Correr** — `pnpm vitest run apps/bot/test/live/persist.test.ts apps/web/test/resumen` → PASS.
- [ ] **Step 5: Commit** — `feat: el diario dice qué viene de Binance y qué se corrigió`.

---

### Task 16: Punta a punta contra el Binance falso *(criterio alto)*

**Files:**
- Create: `apps/bot/test/real/e2e.test.ts`, `apps/bot/test/helpers/real.ts`

**Interfaces:**
- Consumes: `startLive` con dos slots (Task 11), `FakeBinance` mainnet y uno "testnet" (otra instancia con `sapiEnabled false`), `runRealOffCli` (Task 12), base de prueba del bot.
- Produces: `startRealLive(opts: { env: BinanceEnv; enabled: boolean; keys: boolean }): Promise<{ runtime; fakeMain; fakeTest; clock; t }>` en el helper.

- [ ] **Step 1: Escenarios** (reloj manual, `settle`), cada uno un `it`:
  - "abre con stop y TP algorítmicos y la sesión de papel sigue igual" — la de papel cierra ciclos y sus decisiones son las mismas que con la real apagada.
  - "el trailing pone el stop nuevo antes de cancelar el viejo" — orden de pedidos en `fakeTest.requests`.
  - "el stop dispara en Binance y el cierre queda en la base con los números de Binance".
  - "reinicio con una abierta: un solo stop y la posición sigue".
  - "corte del user data stream: reconcilia por REST y no pierde el cierre".
  - "sin la variable sigue cuidando": reiniciar con `enabled false` → no abre, pero el trailing mueve el stop y una salida por tiempo cierra.
  - "tope de pérdida": bajar la marca hasta el piso → todo cerrado, `realStatus 'loss_floor'`, sin algos del bot.
  - "real-off por CLI con el bot vivo" → cerradas con motivo `close_all`, `realStatus 'off'`, y el bot no vuelve a abrir.
  - "una sesión de testnet nunca opera con mainnet": sesión `binanceEnv 'testnet'` y bot en mainnet → `phase 'off'`, `real.mode 'unguarded'`, cero pedidos firmados al falso mainnet.
- [ ] **Step 2: Correr** — `pnpm vitest run apps/bot/test/real/e2e.test.ts` → los que fallen señalan bugs de las tasks anteriores: arreglarlos en su archivo dueño (sin relajar el escenario).
- [ ] **Step 3: Correr todo** — `pnpm test` y `pnpm typecheck` → PASS; `git diff --stat main -- packages/core/test/replay` vacío.
- [ ] **Step 4: Commit** — `test(bot): la operación con plata real de punta a punta contra el Binance falso`.
