# Sereno — bot de trading de futuros con paper trading y dashboard

Fecha: 2026-10-31 · Versión 2 (después de la revisión de cuatro lentes: builder, quant, infra, UX)
Estado: aprobado para construir por decisión de Toti ("no me preguntes, decidí lo mejor para el usuario"). Las dudas que quedaron para él están en `preguntas.md` en la raíz del repo.

> "Sereno" es mi propuesta de nombre (se puede cambiar): el sereno era el vigilante nocturno que recorría las calles y cantaba las horas; este bot vigila el mercado las 24 horas. Y "sereno" también describe el tono del dashboard: calmo, claro, sin ruido.

## 1. Intención y por qué

Toti quiere un bot que mire muchas criptomonedas a la vez, decida por sí solo cuándo abrir un long o un short apalancado en futuros, cuándo cerrarlo y cuándo no hacer nada, y que muestre en un dashboard cómo le va: balance, ganancias y pérdidas por moneda, porcentajes, ROI. Por ahora opera **sólo con plata ficticia**: simula cada operación como si fuera real y arma el balance con el resultado. El criterio para pasar a plata real lo dijo Toti: **que funcione bien y gane más de lo que pierde, de forma sostenida**.

Decisiones que tomó Toti en la conversación (tal cual las dijo):

- Futuros, con apalancamiento, longs y shorts. Muchas monedas a la vez.
- Plata ficticia hasta que demuestre que funciona; las funciones se definen como si fueran reales.
- Reinversión de ganancias configurable.
- Protección del capital inicial: con 100 USD y 70%, cuando gana 70 USD los 100 originales quedan sin usar y sigue sólo con los 70 y lo que gane después.
- Configurar take profit y stop loss, o darle autonomía total al bot.
- Dashboard para desktop y celular, fluido, con animaciones.
- Que el bot aprenda de lo que va haciendo.
- El bot corre 24 horas en un worker, no en Vercel.
- Acceso al dashboard sólo para `owner@example.com`, con Better Auth.
- Dirección visual: base "Libreta" (clara, una columna, titular en castellano), con el tablero de 30 monedas de "Tablero" como pantalla de monedas y la física de "Cristal" (tarjetas deslizables, hojas con spring) sin el vidrio. Los mockups aprobados están en `docs/superpowers/specs/assets/2026-10-31-direccion-visual.html`.
- Calidad sobre velocidad: si algo lleva más tiempo o es más complejo pero sale perfecto, se hace.

Todo lo demás es decisión mía y está marcado como tal; el resumen está en la sección 17.

## 2. Objetivos, no-objetivos y anti-objetivos

**Objetivos**

1. Un motor de decisión que corre solo sobre ~30 monedas, con señales combinadas, y deja registrado el porqué de cada decisión en castellano.
2. Un simulador de exchange fiel: comisiones, funding por evento, slippage, spread, liquidación con la fórmula de Binance, órdenes de stop y take profit que viven en el exchange.
3. Un dashboard que conteste "¿está ganando?" en la primera línea y permita bajar al detalle de posiciones, monedas y aprendizaje, en desktop y celular.
4. Reglas de capital: capital inicial, blindaje por porcentaje, reinversión on/off, dos modos ("el bot decide todo" o "yo fijo tamaño y salidas"), y cortes de pérdida a nivel cuenta que nadie puede saltear.
5. Modo replay: correr la misma estrategia sobre los últimos 90 días de datos reales, sin fugas de futuro, y ver el mismo dashboard.
6. Aprendizaje explicable y acotado: pesos de señales, confianza por moneda y parámetros que se ajustan con evidencia, siempre visibles y comparables contra los valores originales (cartera sombra).
7. Mismo código para simulado y real: una interfaz `Exchange` con `PaperExchange` hoy y `BinanceFuturesExchange` mañana.
8. Un veredicto honesto: el dashboard dice "todavía no se puede saber" hasta tener muestra suficiente, y después dice si hay ventaja estadística.

**No-objetivos (v1)**

- Operar con plata real (la implementación real queda como stub detrás de la interfaz; el modo real está apagado en la UI y requiere claves y confirmación explícita en una etapa futura).
- Spot, opciones, otros exchanges, varios usuarios, notificaciones push/Telegram/email, modelos de machine learning entrenados, app nativa, abrir posiciones a mano desde el dashboard.

**Anti-objetivos (sería un fracaso aunque "funcione")**

- Un dashboard que parezca una terminal genérica, oscura y llena de paneles, o que no se lea en el celu.
- Un bot que cambie su riesgo solo. El aprendizaje sólo puede **reducir** tamaño y ajustar pesos y umbrales dentro de límites; nunca toca riesgo por trade, apalancamiento máximo, posiciones máximas ni cortes de pérdida.
- Aprendizaje opaco: todo cambio se explica en una frase con su tamaño muestral.
- Perder el historial: un redeploy o un reinicio no borra simulaciones, trades ni aprendizaje.
- Resultados de replay que mientan: fills optimistas, stop y take profit resueltos a favor dentro de una vela, indicadores que ven velas que todavía no cerraron, señales que en vivo no existirían.
- Números en vivo que no lo son: si el bot está sin conexión, el dashboard lo dice en todas partes y marca cada número con su hora.

## 3. Restricciones y hechos verificados

- **Binance rechaza con HTTP 451** ("Service unavailable from a restricted location according to 'b. Eligibility'") las IPs de jurisdicciones restringidas (EE.UU., Países Bajos) y además muchos rangos de datacenter/cloud, incluso en endpoints públicos y websockets. Por eso el dashboard (Vercel, región `iad1`) **nunca** llama a Binance: sólo el bot habla con Binance; el dashboard lee y escribe en la base. El bot trata 451, 418 y 429 como errores con backoff y los refleja en su estado ("Binance rechaza la IP del worker").
- **Dónde corre el bot:** en la Mac de Toti con `pnpm bot` (que corre con `caffeinate -i` para que la Mac no se duerma mientras el bot está activo). Railway queda **descartado** (su staff confirma que sus cuatro regiones usan rangos que Binance bloquea). Candidatos para después, con un **gate de despliegue** obligatorio (`curl https://fapi.binance.com/fapi/v1/ping` desde esa IP tiene que devolver 200): VPS de Hetzner (Helsinki o Falkenstein) o Fly.io (ams/fra). Es una pregunta abierta para Toti.
- **Base de datos:** Postgres en Neon, base `sereno` y rol `sereno_app` en el proyecto compartido "Marrona", siguiendo `marrona-neon-db` (rol creado por SQL para evitar `neon_superuser`, dos revokes, dos connection strings). Como el bot escribe cada pocos segundos, el cómputo del proyecto no se duerme nunca; el costo (~US$20/mes a 0,25 CU si el proyecto no estuviera ya siempre encendido) y la opción de graduar Sereno a su propio proyecto están en `preguntas.md`.
- **Dashboard:** Next.js 16 (App Router, runtime Node) en Vercel. Un solo endpoint de lectura periódica para no quemar invocaciones ni egress (sección 11.5).
- **Datos de mercado sin claves:** todo lo necesario para paper trading es público. Claves de Binance sólo para el modo real (futuro) o, opcionalmente, una clave de sólo lectura para traer los tiers reales de margen de mantenimiento.
- **Límites de Binance (USDT-M):** 2.400 de peso por minuto en REST (klines con `limit=1500` pesa 10; `ticker/24hr` sin símbolo pesa 40; `premiumIndex` sin símbolo pesa 10); `/futures/data/*` (open interest, ratios) tiene límite aparte de 1.000 requests por 5 minutos y sólo guarda los últimos 30 días; `fundingRate` y `fundingInfo` comparten 500 requests por 5 minutos. El cliente REST del bot tiene un limitador central que lee `X-MBX-USED-WEIGHT-1M` y frena antes del 429.
- **Websocket de Binance (desde abril de 2026):** las rutas están partidas. `kline_*` y `markPrice` viven en `wss://fstream.binance.com/market/stream`; `bookTicker` vive en `/public/stream`; las URLs legadas `/ws` y `/stream` sin ruta fueron decomisionadas el 2026-04-23. Una conexión dura 24 horas como máximo, el servidor manda ping cada 3 minutos (desconecta si no hay pong en 10), se aceptan 10 mensajes entrantes por segundo y hasta 1.024 streams por conexión. El stream `markPrice` trae `r` (funding actual) y `T` (próximo funding).
- **Funding:** el intervalo es por contrato (hoy la mayoría a 4 horas, muchos a 8, algunos a 1) y cambia dinámicamente; sale de `GET /fapi/v1/fundingInfo` (`fundingIntervalHours`, 8 si el símbolo no aparece) y el próximo evento de `nextFundingTime`. El historial (`GET /fapi/v1/fundingRate`) trae tasa, hora y precio de marca de cada evento.
- **Mínimos por contrato:** salen de `exchangeInfo` (`MIN_NOTIONAL.notional`: hoy 5 USDT en la mayoría, 20 en algunos, 50 en BTCUSDT; `LOT_SIZE.minQty/stepSize`; `PRICE_FILTER.tickSize`). Nunca una constante.
- **Un solo usuario.** Zona horaria para mostrar: `America/Argentina/Buenos_Aires` (el proceso corre en UTC). Idioma: castellano rioplatense, voseo. Moneda: `US$ 1.247,80` (formato es-AR, signo menos tipográfico U+2212, numerales tabulares sólo en columnas).

## 4. Arquitectura

Monorepo TypeScript con pnpm workspaces y Turborepo. Node 22. Modo estricto en todo. Vitest para pruebas.

```
sereno/
  apps/
    bot/        proceso 24/7: Binance → motor → base de datos; también corre los replays
    web/        Next.js 16: dashboard + Better Auth + endpoints internos
  packages/
    core/       motor puro, sin IO ni reloj propio: indicadores, señales, universo, riesgo,
                capital, simulador de exchange, aprendizaje, replay, estadísticas, diario
    db/         esquema Drizzle, migraciones, clientes (pooled y directo), repositorios
    shared/     tipos, zod schemas de configuración y comandos, formateo es-AR, constantes
  docs/superpowers/specs/     este documento y los mockups
  docs/superpowers/plans/     el plan de implementación
```

**Flujo de datos**

```
Binance (REST + WS) ──► apps/bot ──► packages/core (decisiones puras) ──► Neon (Postgres)
                                                                             ▲
                                                    apps/web (Vercel) ◄──────┘
                                                    lee estado; escribe ajustes y comandos
```

- El bot es la única fuente de verdad sobre mercado, posiciones y aprendizaje. El dashboard lee de la base y nunca calcula resultados por su cuenta (sólo formatea lo que el bot guardó, más el no realizado de las abiertas usando el último `market_snapshot`).
- El dashboard controla al bot **a través de la base** (sección 10: `bot_commands` con claim atómico, vencimiento e idempotencia; `settings` con versión; `bot_lease` para instancia única). No hay red directa entre Vercel y el bot.
- `packages/core` **no tiene IO ni reloj**: recibe un `MarketView` fechado y configuración, devuelve decisiones y eventos. La diferencia entre vivo y replay es sólo quién alimenta el motor con datos y relojes. Esto es lo que hace testeable el motor y comparable el replay.

## 5. El motor de decisión (`packages/core`)

### 5.1 Universo

Candidatos: contratos de `exchangeInfo` con `contractType = PERPETUAL`, `status = TRADING`, `quoteAsset = USDT`, `underlyingType = COIN`, `underlyingSubType` sin `TradFi`, `baseAsset` fuera de la lista de stablecoins (USDC, FDUSD, TUSD, USDP, DAI, USDe y similares) y `onboardDate ≤ hoy − 60 días`. Toggle en Ajustes "incluir TradFi (oro, acciones tokenizadas)" apagado por defecto.

Ranking: las 30 con mayor `quoteVolume` de las últimas 24 horas (`ticker/24hr`, una llamada diaria). Se recalcula a las 00:05 UTC; el universo de cada día se guarda en `universe_days` con el snapshot de filtros y mínimos de cada contrato. Una moneda que sale del top 30 con posición abierta se mantiene hasta cerrarla. Toti puede fijar monedas (siempre adentro) o excluirlas. La función de selección es pura (`selectUniverse(contracts, volumes, settings)`) y es la misma en vivo y en replay (donde el volumen del día anterior sale de velas diarias).

### 5.2 Datos, marcos y causalidad

- Velas de **15 minutos** para decidir entradas; **1 hora y 4 horas** para tendencia mayor; **1 hora** para volatilidad (ATR). Calentamiento: 300 velas por marco y símbolo.
- **Regla de causalidad** (vale en vivo y en replay, con test propio): el motor recibe en cada evaluación un `MarketView` fechado en `t` (cierre de la vela de 15m) y sólo ve datos con marca de disponibilidad `≤ t`. Una vela de marco M está disponible cuando `closeTime ≤ t`: a las 10:15 la vela "vigente" de 4h es la que cerró a las 08:00, nunca la 08:00–12:00. Datos de futuros: disponibles si `timestamp ≤ t`. En vivo esto significa que los indicadores de 1h/4h se calculan sólo con velas cerradas (`x = true` en el stream).
- **Volatilidad:** `ATR_1h` = ATR(14) de Wilder sobre velas de 1 hora. Es el único ATR que usan tamaño, stop, take profit y trailing; se **congela al abrir** la posición. La normalización del histograma MACD usa el ATR del marco de la señal (15m), que es otra cosa.
- Entradas: al cierre de cada vela de 15m, con un plazo de 3 segundos después del cierre: se decide con las velas que llegaron cerradas y las que faltan se marcan "sin vela" en `decisions`. Se evalúan todas las monedas del universo y se entra primero en las de mayor confianza.
- Salidas: con cada tick de precio de marca (`markPrice@1s`) como respaldo, y además como órdenes vivas en el exchange (sección 6).
- Datos de futuros por REST cada 5 minutos: open interest (`openInterestHist`, período 1h), ratio long/short de cuentas y ratio taker buy/sell (período 1h), intervalos de funding (`fundingInfo`, diario). Funding actual y próximo salen del stream `markPrice` (`r`, `T`).

### 5.3 Señales, modificadores y filtros

Tres listas distintas, cada idea nombrada una sola vez (decisión mía tras la revisión cuantitativa).

**(a) Señales** con valor `sᵢ ∈ [−1, +1]` (negativo = short) y peso aprendible `wᵢ` (base 1,0):

| Señal | Qué mide | Cálculo del valor |
|---|---|---|
| Tendencia 15m | EMA 20/50/200 y pendiente | +1 si 20>50>200 con pendiente de EMA20 positiva, −1 simétrico, intermedio proporcional a cuántas condiciones se cumplen |
| Tendencia mayor | Lo mismo en 1h y 4h (velas cerradas) | Promedio de ambos marcos |
| Momentum | RSI(14) y MACD(12,26,9) en 15m | 0,5·RSI centrado en 50 (recortado a ±1 en 25/75) + 0,5·histograma MACD / ATR_15m recortado. Sobrecompra (RSI > 75) y sobreventa (< 25) **restan** al lado que confirma |
| Ruptura | Canal de Donchian(20) sobre las 20 velas **anteriores** a la de decisión | +1 si cierra por encima del máximo del canal, −1 por debajo del mínimo, 0 en el medio |
| Bandas | Bollinger(20, 2) en 15m | Media-reversión suave: posición en banda −1…+1 invertida y a la mitad (cerca de la banda superior resta al long) |
| VWAP | Precio vs VWAP anclado al día UTC | +0,5 si arriba con VWAP ascendente, −0,5 simétrico, 0 si cruzando |
| Funding | Tasa actual (`r`) anualizada vs 0 | Contrarian suave: funding > +0,05% por período resta a longs hasta −0,5; < −0,05% resta a shorts |
| Open interest | Cambio de OI en 1h y 4h junto al precio | Precio sube + OI sube = +0,5…+1; precio sube + OI baja = +0,2; simétrico para bajas |
| Posicionamiento | Ratio long/short de cuentas y taker buy/sell | Extremos (> 2 o < 0,5) son contrarian suave (±0,5) |
| Régimen BTC | Tendencia 4h de BTC (EMA) | Para alts: +0,5 si BTC en tendencia alcista, −0,5 si bajista; BTC mismo usa 0 |

Puntaje compuesto **sobre señales disponibles**: `S = Σ_{disp} wᵢ·sᵢ / Σ_{disp} wᵢ`. Las señales sin datos (OI fuera de los 30 días en replay, funding previsto no disponible, etc.) no entran al numerador ni al denominador y quedan listadas en `decisions.missingSignals`. Confianza `c = |S|`.

**(b) Modificadores de S** (no aprendibles): `S' = S × mADX × mVol`, con `mADX = 0,5` si ADX(14, 15m) < 20, `1,0` si 20–40, `1,1` si > 40 (tope 1); `mVol = clamp(volumenRelativo, 0,7, 1,2)` donde volumen relativo = volumen de la vela / media de las últimas 96 velas de 15m (24 horas). `S'` es lo que se compara con el umbral.

**(c) Filtros de entrada y modificadores de tamaño** (booleanos, no aprendibles):

- Tendencia mayor en contra en 1h **y** 4h ⇒ no entrar. En contra en uno solo ⇒ confianza a la mitad.
- Volumen relativo < 0,8 ⇒ no entrar.
- Volatilidad extrema de BTC (volatilidad realizada 24h > 2 × su media de 30 días) ⇒ tamaño × 0,5.
- Sin posición abierta en la moneda; moneda no en enfriamiento ni en penitencia; símbolo no degradado por falta de datos.

El reporte de replay incluye el histograma de `S'` y la matriz de correlación entre señales, para calibrar θ con datos y no a ojo.

### 5.4 Reglas de entrada y capacidad

- Long si `S' ≥ θ`, short si `S' ≤ −θ`. Umbral inicial `θ = 0,35`.
- Enfriamiento por moneda: después de una pérdida, 4 velas (1 hora) sin reentrar en esa moneda.
- Enfriamiento global: después de 3 stops en la misma hora, 2 velas sin entradas nuevas.
- Capacidad (todas sobre `capitalBase`, sección 7): posiciones abiertas < `maxPosiciones` (5); como máximo 3 en la misma dirección; `margenEnUso + margenNuevo ≤ 60% × capitalBase`; `nocionalTotal + nocionalNuevo ≤ 3 × capitalBase`; `capitalOperable ≥ margenNuevo`.
- Cortes a nivel cuenta (sección 7) vigentes: sin pérdida diaria agotada, sin pausa por drawdown, sin pausa por racha.
- En el modo "yo fijo tamaño y salidas" Toti puede además restringir la dirección (sólo long, sólo short, ambas).

### 5.5 Tamaño y apalancamiento (modo "el bot decide todo")

El tamaño se decide por riesgo, y el apalancamiento se deriva del stop para que la liquidación quede lejos (decisión mía):

```
costoIdaVuelta   = 2 × taker + spread + 2 × slippage                  (por símbolo; sección 6)
distanciaStop    = max(k × ATR_1h / precio, 8 × costoIdaVuelta)       (k = 1,5 por defecto)
                   si 8 × costoIdaVuelta > 2 × k × ATR_1h / precio ⇒ no entrar ("stop demasiado chico para el costo")
riesgoUsd        = capitalBase × riesgoPorTrade × mConfianza × mMoneda × mBTC
                   riesgoPorTrade = 1% ; mConfianza = 0,6 + 0,4·c ; mMoneda ∈ [0,5; 1,0] (sección 8) ; mBTC ∈ {0,5; 1}
nocionalObjetivo = riesgoUsd / distanciaStop
apalancamiento   = clamp(floor(1 / (3 × distanciaStop + mmr)), 1, apalancMax)   (apalancMax = 5)
margen           = nocionalObjetivo / apalancamiento
si margen > capitalBase × margenMaxPorTrade (20%) ⇒ margen = ese tope y nocional = margen × apalancamiento (se reduce el nocional, no el apalancamiento)
cantidad         = floor(nocional / precio, stepSize)
nocionalFinal    = cantidad × precio ; riesgoReal = nocionalFinal × distanciaStop
```

- Invariante testeado: `|precioLiquidación − entrada| ≥ 3 × |stop − entrada|`; si no se cumple, no se abre.
- Mínimos: si `nocionalFinal < minNotional` o `cantidad < minQty` ⇒ no se abre y la decisión lo registra ("tamaño por debajo del mínimo del contrato"). Si `riesgoReal > 1,5 × riesgoUsd` (el step obligó a subir) ⇒ no se abre.
- Todos los multiplicadores están en `(0, 1]`: **un stop tocado pierde como máximo el 1% del capital base**. `riesgoReal` se guarda en la posición y es la base del R múltiplo (`R = pnlNeto / riesgoReal`).
- Ajustes › Universo muestra qué símbolos quedan fuera por mínimo con el capital actual.

**Modo "yo fijo tamaño y salidas":** Toti fija margen por trade (USD o % del capital base), apalancamiento fijo (1–20), TP y SL en porcentaje de precio (el formulario los traduce a USD y a % del margen en vivo y valida que el SL quede antes de la liquidación), trailing opcional en %, posiciones máximas y dirección. En este modo no aplican los topes de 20% de margen por trade, 60% de margen en uso ni 3× de nocional; sí aplican los cortes a nivel cuenta, una posición por moneda, los mínimos del contrato y `capitalOperable ≥ margen` (si no alcanza, no se abre y el diario lo dice). El bot sigue eligiendo **cuándo** entrar y **en qué dirección**. El ejemplo de Toti ("long 5x con 50 USD" sobre 100) se expresa acá. `riesgoReal = nocional × SL%` también acá, así R y el aprendizaje están definidos.

### 5.6 Salidas

Modo "el bot decide todo" (todo en unidades de R; parámetros iniciales ajustables por aprendizaje dentro de su grilla):

- Stop loss inicial a `distanciaStop` del precio de entrada, como orden `STOP_MARKET` (dispara por marca) en el exchange.
- Take profit a `tpR × distanciaStop` (tpR = 2) como orden `TAKE_PROFIT_MARKET`. Sigue vivo durante el trailing: cierra el que llegue primero.
- Trailing: cuando la posición supera +1R (con precio de marca), el stop se mueve a entrada y después sigue a `trailingR × distanciaStop` (trailingR = 1,0) del mejor precio de marca alcanzado; cada movimiento reemplaza la orden de stop en el exchange.
- Salida por señal: si `S'` cruza al lado opuesto más allá de `θ_apertura / 2` (el θ vigente cuando se abrió, guardado en la posición), se cierra a mercado.
- Salida por tiempo: a las 48 horas, si el no realizado del momento no supera +0,3R, se cierra.
- Liquidación: si el precio de marca cruza el precio de liquidación, el exchange cierra la posición y se pierde el margen completo.

Modo "yo fijo tamaño y salidas": TP y SL fijos en % de precio como órdenes en el exchange, trailing opcional, sin salida por señal ni por tiempo salvo que Toti las active.

Cada apertura y cierre guarda: todas las señales con valor y peso efectivo, señales ausentes, `S`, `S'`, confianza, multiplicadores, `distanciaStop`, `riesgoReal`, `θ` vigente, el motivo en una frase ("Abrí un long 5x en SOL con US$ 50. La tendencia en 1h y 4h acompaña y el funding está negativo."), precio de marca y último, spread y slippage aplicados, latencia decisión→fill.

## 6. El simulador de exchange (`PaperExchange`)

Interfaz común (one-way mode, margen aislado):

```ts
interface Exchange {
  placeMarketOrder(req: MarketOrder): Promise<Fill>
  placeStopMarket(req: StopOrder): Promise<OrderId>          // STOP_MARKET, closePosition, workingType MARK_PRICE
  placeTakeProfitMarket(req: StopOrder): Promise<OrderId>    // TAKE_PROFIT_MARKET, idem
  cancelOrder(symbol: string, orderId: OrderId): Promise<void>
  closePosition(symbol: string, reason: CloseReason): Promise<Fill>
  getPositions(): Promise<Position[]>
  getOpenOrders(symbol?: string): Promise<Order[]>
  getBalance(): Promise<Balance>
  setLeverage(symbol: string, leverage: number): Promise<void>
  onMarkPrice(cb: (tick: MarkTick) => void): Unsubscribe
  onFunding(cb: (ev: FundingEvent) => void): Unsubscribe
}
```

Reglas del simulador, calibradas a Binance USDT-M (decisiones mías):

- Órdenes a mercado. Comisión taker 0,05% sobre el nocional al precio de fill, en apertura y cierre; sin descuento BNB; `takerFeeRate` y `makerFeeRate` configurables (avanzado) para cuando se conozca el tier real.
- Fill en vivo: último precio ± medio spread (leído por REST `bookTicker` del símbolo en el momento de la orden) ± slippage de 0,02% (+0,01% por cada 10.000 USDT de nocional). Fill en replay: apertura de la vela siguiente a la decisión ± medio spread por símbolo (0,01% BTC/ETH, 0,025% resto, reemplazado por la mediana observada en vivo cuando haya 24 horas de datos en `symbols.observedSpread`) ± el mismo slippage. Nunca se llena al cierre de la vela que disparó la decisión.
- Órdenes de stop y take profit: disparan por precio de marca y se llenan a último precio menos (medio spread + 2 × slippage) en contra; igual que Binance, que dispara por marca y ejecuta a mercado.
- Funding: en cada `fundingTime` del contrato se paga o cobra `cantidad × precioMarca(fundingTime) × tasa`, signo según el lado. En vivo el próximo evento sale de `T` y la tasa de `r`; en replay se itera el historial de `fundingRate`, que ya refleja los cambios de intervalo.
- Liquidación (margen aislado, tier 1, `cum = 0`): `long: LP = entrada × (1 − 1/L) / (1 − mmr)`, `short: LP = entrada × (1 + 1/L) / (1 + mmr)`. `mmr` por símbolo de una tabla en `settings` con valores iniciales documentados como supuestos (BTC 0,4%, ETH 0,5%, top 10 alts 1%, resto 2%); un job opcional la rellena desde `leverageBracket` si hay clave de sólo lectura. Al liquidar: pérdida = margen completo más comisión; se registra `liquidationFee` del contrato en el evento.
- Replay, resolución 15 minutos con **velas de precio de marca** (`markPriceKlines`) para stop, TP y liquidación, y velas de último precio para señales y fills de entrada. Orden canónico dentro de cada vela, sin excepciones: apertura → si abre más allá del stop o la liquidación, fill en la apertura → extremo adverso (stop, liquidación) → extremo favorable (take profit, actualización de trailing y breakeven) → cierre. Nunca se actualiza el trailing con el extremo favorable antes de haber chequeado el adverso de la misma vela. Es el peor caso: el sesgo es en contra del bot, y el reporte lo dice ("resolución de 15 minutos, peor caso intra-vela").
- Resultado de cada trade: `pnlNeto = pnlBruto − comisiones ± funding`, `R = pnlNeto / riesgoReal`, y los costos desglosados (comisiones, spread, slippage, funding).

`BinanceFuturesExchange` queda con la firma implementada y el cuerpo que lanza "modo real deshabilitado". La UI muestra el modo real apagado y explica qué falta para prenderlo (claves, confirmación, revisión del veredicto).

## 7. Reglas de capital y cortes de pérdida

Estado de la cuenta por simulación:

- `capitalInicial` (I₀): se pide al crear la simulación; sugerido US$ 1.000; es inmutable y es la referencia del titular y del ROI.
- `saldo` = I₀ + resultado realizado (trades cerrados, comisiones, funding). `equity` = saldo + no realizado de las abiertas.
- `baseBlindaje`: empieza en I₀; `protegido`: 0 hasta que se dispara el blindaje; después `baseBlindaje`.
- `capitalBase` = `saldo − protegido` (con reinversión apagada: `min(saldo − protegido, baseBlindaje)`). Es la base de todos los porcentajes: riesgo por trade, margen por trade, margen máximo, nocional máximo, cortes de pérdida.
- `capitalOperable` = `max(0, capitalBase − margenEnUso)`: lo que queda para margen nuevo.

**Blindaje del capital inicial** (regla de Toti, con las precisiones de la revisión): con porcentaje `p`, en el momento en que `min(resultadoRealizado, equity − baseBlindaje) ≥ p × baseBlindaje`, `protegido` pasa a ser `baseBlindaje` y queda así. Desde entonces el bot opera sólo con la ganancia. Qué pasa con las abiertas al disparar (ajuste `alBlindar`, por defecto `reducir`): `mantener` (se aceptan), `reducir` (si la suma de márgenes de las abiertas supera `saldo − baseBlindaje`, se cierran en orden de peor R vigente hasta que entre, con motivo "reducción para blindar el capital inicial"), `cerrar todo`. Si `capitalOperable` no alcanza para el mínimo de una posición, el bot se pausa solo con el motivo "capital blindado y sin ganancia para operar". **Volver a usar el capital blindado** (acción explícita en Ajustes y en la tarjeta de capital, con confirmación): `protegido = 0`, `baseBlindaje = saldo` en ese momento, y el disparador vuelve a medir `p × baseBlindaje` de ganancia nueva desde ahí. El titular y el ROI siguen midiendo contra I₀. Resumen muestra "capital blindado en riesgo: US$ X" cuando las abiertas superan el colchón.

**Reinversión** (regla de Toti): activa, el tamaño se calcula sobre `capitalBase` completo (interés compuesto). Apagada, sobre `min(capitalBase, baseBlindaje)`: el bot opera siempre como si tuviera el capital inicial y la ganancia se acumula aparte. Con el capital blindado y reinversión apagada, la base es la ganancia disponible (la UI lo aclara: "no aplica mientras el capital esté blindado").

**Cortes a nivel cuenta** (no aprendibles; editables en Ajustes › Riesgo con valores por defecto visibles y "restablecer"):

- Pérdida diaria máxima: 3% de `capitalBase` realizada en el día de Buenos Aires (desde las 00:00 de Buenos Aires, el mismo "hoy" que muestra el dashboard) ⇒ no se abren posiciones hasta el día siguiente.
- Drawdown máximo: 15% desde el pico de equity ⇒ pausa automática con aviso ("pausado solo: drawdown del 15%"); Toti reanuda a mano.
- Racha: 6 stops seguidos ⇒ 4 horas sin entradas.
- Concentración: máximo 3 posiciones en la misma dirección.

**Modos**: `auto` ("el bot decide todo") o `custom` ("yo fijo tamaño y salidas"). Se cambian en caliente; afectan a las posiciones nuevas, no a las abiertas (la UI lo dice al guardar).

**Pausa** (por comando o automática): el bot **no abre posiciones nuevas** ni evalúa entradas, pero **sigue cuidando las abiertas**: stop, take profit, trailing, salida por señal, salida por tiempo, liquidación y funding siguen; el latido, el snapshot de mercado, los comandos y el aprendizaje siguen. "Pausar y cerrar todo" es la segunda opción. El estado de pausa es un campo de `settings` (`pausado`, por quién, cuándo, motivo), no un comando.

## 8. Aprendizaje

Objetivo: que el bot mejore con lo que hace, con evidencia suficiente, y que Toti vea y entienda cada cambio. El aprendizaje pertenece a **cada simulación** (`learning_state` por sesión). Al crear una simulación nueva, Toti elige: aprendizaje desde cero, continuar con el de la simulación actual, o arrancar con lo aprendido en un replay. "Reiniciar aprendizaje" vuelve la simulación a los valores por defecto.

**Qué aprende**

1. **Pesos de señales**, globales y por moneda, por dos vías:
   - *Trades cerrados* (auto y custom): cada señal recibe `cᵢ = sᵢ × dirección` y el trade `r = clamp(R, −2, 2) / 2`. `wᵢ ← clamp(wᵢ + η·cᵢ·r, 0,2, 2,0)` con `η = 0,02`. Congelado hasta 50 trades cerrados en la simulación ("juntando datos: 23 de 50").
   - *Decisiones no tomadas*: cada fila de `decisions` recibe a posteriori el retorno del precio a 4 y 24 horas. Una vez por semana, para cada señal se calcula la correlación de Spearman `ρᵢ` entre `sᵢ` y el retorno a 4h sobre los últimos 28 días (todas las monedas) y `wᵢ(global) ← clamp(wᵢ + 0,5·ρᵢ, 0,2, 2,0)`. Esa correlación es la "fiabilidad" que muestra la tabla de señales; con menos de 10 pares en la ventana la señal queda "sin dato" y su peso no se mueve.
   - Tope de cambio acumulado por señal: ±0,15 por semana entre las dos vías. Peso efectivo por moneda con encogimiento: `efectivo = (1 − λ)·global + λ·moneda`, `λ = n / (n + 30)` con `n` = trades cerrados en la moneda.
2. **Confianza por moneda**: EMA del resultado `r` (α = 0,2). Multiplicador de tamaño `mMoneda = clamp(1 + confianza, 0,5, 1,0)`: **sólo reduce, nunca aumenta**. Si después de 8 trades la confianza baja de −0,4, la moneda queda **en penitencia** 7 días; al volver arranca en −0,2. El umbral es −0,4 porque con `r = R/2` una racha de stops a −1R converge a −0,5 sin cruzarlo nunca; con −0,4 la penitencia llega al octavo stop seguido (−0,416; con siete, −0,395).
3. **Parámetros**: `θ ∈ {0,30; 0,35; 0,40; 0,45; 0,50}`, `k ∈ {1,0; 1,5; 2,0}`, `tpR ∈ {1,5; 2; 3}`, `trailingR ∈ {0,75; 1,0; 1,5}` (135 combinaciones). **Una vez por semana** (domingo 00:30 UTC) el bot corre en memoria, con las velas ya guardadas y las señales precalculadas una sola vez (los parámetros no cambian las señales, sólo decisiones y posiciones), un **walk-forward** sobre los últimos 60 días: optimiza en los días −60…−15 y valida en −15…0, con los pesos actuales congelados y sin cartera sombra. Adopta una combinación sólo si (a) tiene al menos 60 trades en la ventana de optimización, (b) su expectativa por trade **en R** supera a la vigente en más de 2 errores estándar y en al menos 0,1R absoluto, (c) también supera a la vigente en la ventana de validación, y (d) la combinación vigente lleva al menos 7 días. El diario registra también las combinaciones rechazadas y por cuánto. Dentro de un replay el ajuste de parámetros está apagado por defecto (flag).

**Qué no toca nunca**: riesgo por trade, apalancamiento máximo, posiciones máximas, margen máximo, cortes de pérdida, ni ninguna regla de capital.

**Sombra**: en cada ciclo el motor también decide con los pesos y parámetros **por defecto del documento** (congelados en `sessions.settingsSnapshot`) y lleva una cartera virtual paralela con las mismas reglas de capital, universo y enfriamientos, su propia penitencia y sin multiplicador de confianza por moneda. Comparación: diferencia de retorno en puntos porcentuales de I₀ en el período y suma de R, con mínimo 20 trades en cada cartera. Si durante 14 días la sombra rinde más de 3 puntos porcentuales de I₀ por encima de lo aprendido, el dashboard lo avisa y sugiere reiniciar el aprendizaje (no lo hace solo). Cuando hubo pre-entrenamiento, Aprendizaje muestra una tercera referencia "punto de partida".

**Controles**: congelar aprendizaje, reiniciar aprendizaje (confirmación), ver el diario de cambios. Cada cambio queda en `learning_log` con su frase y su tamaño muestral ("Bajé el peso del RSI en SOL de 1,0 a 0,8: votó a favor en 6 de los últimos 8 trades perdedores (n = 14)").

## 9. Replay

- Toti elige: días (por defecto 90), capital inicial, configuración (la actual o una guardada), aprendizaje desde cero o el vigente, y si corre el ajuste de parámetros (apagado por defecto).
- Datos: para cada día del período, el universo se recalcula con la misma función del vivo usando el `quoteVolume` de las velas diarias del día anterior (`klines` 1d de todos los candidatos; una llamada por símbolo); los contratos candidatos salen del `exchangeInfo` de hoy, lo que deja afuera a los deslistados (sesgo de supervivencia, declarado en el reporte). Para los símbolos que entran se descargan velas de 15m, 1h y 4h de último precio y de precio de marca, más 300 velas de calentamiento, el historial de funding, y OI y ratios donde existan. Símbolo que sale del universo con posición abierta: se mantiene hasta cerrar; símbolo sin más velas (deslistado): se cierra al último precio disponible con motivo "símbolo deslistado".
- Corre el mismo motor, vela a vela, con reloj simulado y la regla de causalidad de 5.2. Fills según la sección 6. Se guarda como una **sesión** de tipo `replay` con las mismas tablas, y el dashboard la muestra con las mismas pantallas en contexto de replay (11.1).
- Progreso visible: la sesión replay tiene `estado` (`en cola`, `descargando`, `simulando`, `listo`, `fallido`, `cancelado`), `progreso` (0–1) y `mensaje` ("Descargando velas · 12 de 30 monedas", "Simulando · día 41 de 90"). Se puede cancelar.
- Costo: un replay de 90 días con 30 monedas son ~260.000 velas de 15m por tipo de precio; se guardan en `candles` (compartida) y se reutilizan. La descarga inicial respeta el limitador (≤ 150 llamadas de peso 10 por minuto); el cómputo es de segundos a un par de minutos en la Mac. Corre en un worker thread del proceso del bot mientras el vivo sigue.
- Reporte: trades, ganados y perdidos, ganancia neta, ROI, factor de beneficio, expectativa en R, drawdown máximo "por vela, peor caso", mejor y peor moneda, costos desglosados (comisiones, spread, slippage, funding), costo medio / riesgo medio en R, trades por quincena, histograma de `S'`, correlación entre señales, universo por día, y la lista de señales no disponibles con sus fechas.

## 10. Persistencia (Neon, Drizzle)

Tablas (nombres definitivos; columnas exactas a criterio del builder salvo las nombradas):

- `sessions`: id, kind (`paper_live` | `replay` | `live`), name, status (`active` | `archived` | replay states), capitalInicial, baseBlindaje, protegido, settingsSnapshot (jsonb, incluye los valores por defecto para la sombra), learningOrigin (`zero` | `continued` | `replay:<id>`), startedAt, endedAt, progreso, mensaje, replayParams (jsonb).
- `settings`: una fila por sesión en vivo: config completa validada por zod (modo, capital, riesgo, salidas, universo, mmr por símbolo, fees, pausado + pausadoPor + pausadoEn + pausaMotivo, aprendizaje congelado), `version` entero. Escrituras con `UPDATE … WHERE id = $id AND version = $expected` (optimistic locking); `settings_history` guarda cada versión con quién y cuándo.
- `symbols`: symbol, filtros de `exchangeInfo` (minNotional, minQty, stepSize, tickSize, quantityPrecision), underlyingType/subType, onboardDate, fundingIntervalHours, liquidationFee, mmr, observedSpread, updatedAt.
- `universe_days`: sessionId, day, symbols[] con ranking y snapshot de mínimos.
- `positions`: sessionId, symbol, side, leverage, margin, notional, qty, entryPrice, exitPrice, stopPrice, takeProfitPrice, liquidationPrice, trailingActive, bestPrice, riesgoReal, distanciaStop, thetaAtOpen, fees, funding, pnlGross, pnlNet, rMultiple, openReason (frase), closeReason (enum + frase), signalsAtOpen (jsonb), missingSignals, costs (jsonb), latencyMs, openedAt, closedAt, shadow boolean.
- `position_events`: positionId, kind (open, stop_moved, funding, partial_close, close, liquidation, order_placed, order_cancelled), payload, at.
- `decisions`: sessionId, symbol, candleCloseTime, S, Sprime, signals (jsonb), missingSignals, action (`enter_long` | `enter_short` | `wait` | `blocked:<filtro>`), blockedBy, forwardReturn4h, forwardReturn24h (rellenados después), shadowAction. Retención 30 días en vivo; completas en replay; insert por lote al cierre de cada vela.
- `equity_snapshots`: sessionId, at, saldo, equity, margenEnUso, protegido, capitalBase, capitalOperable, shadowEquity, kind (`minute` | `event`). Índice `(sessionId, at desc)`. Retención: por minuto 90 días; por evento siempre.
- `market_snapshot`: sessionId (pk), updatedAt, version, symbols (jsonb: precio de marca, cambio 24h, `S'`, inclinación, estado del símbolo). `INSERT … ON CONFLICT (sessionId) DO UPDATE`, `fillfactor = 50`.
- `candles`: symbol, timeframe, priceType (`last` | `mark`), openTime, OHLCV, closed. Única por (symbol, timeframe, priceType, openTime).
- `futures_data`: symbol, at, fundingRate, nextFundingTime, openInterest, longShortRatio, takerRatio.
- `learning_state`: sessionId (pk), weightsGlobal, weightsBySymbol, confidenceBySymbol, tradesBySymbol, params (θ, k, tpR, trailingR, since), frozen, closedTrades, version. `learning_log`: sessionId, at, kind, message, sampleSize, before, after.
- `bot_status`: sessionId (pk), instanceId, lastHeartbeat, phase (`starting` | `warming` | `live` | `paused` | `waiting_lease`), warmProgress, universeSize, lastCycleAt, settingsVersionApplied, degradedSymbols[], flags (jsonb: btcVolExtreme, dailyLossHit, drawdownPause, streakPause, learningFrozen), recentErrors (jsonb), version del bot.
- `bot_lease`: sessionId (pk), instanceId, leaseUntil. El bot renueva cada 10 s junto con el latido y sólo opera si el lease es suyo (`UPDATE … WHERE instanceId = $me OR leaseUntil < now()`); un segundo proceso arranca en `waiting_lease` y lo dice.
- `bot_commands`: id uuid (generado por el cliente; clave de idempotencia con `ON CONFLICT DO NOTHING`), sessionId, kind (`close_position` | `close_all` | `run_replay` | `cancel_replay` | `release_protected` | `reset_learning`), payload, status (`pending` | `claimed` | `done` | `failed` | `expired` | `cancelled`), createdAt, expiresAt (60 s para los sensibles al precio; null para el resto), claimedAt, claimedBy, finishedAt, result, requestedBy (email). Claim atómico: `UPDATE … SET status='claimed' WHERE id = (SELECT id … WHERE status='pending' AND (expiresAt IS NULL OR expiresAt > now()) ORDER BY createdAt FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`; los vencidos se marcan `expired` sin ejecutarse.
- Tablas de Better Auth (`user`, `session`, `account`, `verification`).

Conexiones: el bot usa `DATABASE_URL_UNPOOLED` con `pg.Pool` (máximo 4 conexiones) y `drizzle-orm/node-postgres`; el dashboard usa `DATABASE_URL` (pooled) con `drizzle-orm/neon-serverless`; las migraciones usan la directa y se corren desde el repo (`db:generate` → revisar SQL → `db:migrate`; nunca `push` contra Neon).

Volumen: ~3.000 decisiones por día, ~1.500 snapshots de equity por día, 1 fila viva de mercado, velas de 30 símbolos × 3 marcos × 2 tipos; menos de 300 MB por año. Limpieza diaria de `decisions` (> 30 días en vivo) y `equity_snapshots` por minuto (> 90 días).

## 11. El dashboard (`apps/web`)

### 11.1 Pantallas y estados

Vocabulario fijo: la sesión de trading se llama **simulación** (o **replay**); "cerrar sesión" es sólo salir de la cuenta. Navegación: barra inferior en el celu (ícono + etiqueta de 11px), barra superior en desktop. Cinco destinos: **Resumen, Posiciones, Monedas, Aprendizaje, Ajustes**. Chip persistente junto al nombre: "Simulado", "Replay · 90 días" o "Real".

**Contexto de sesión.** La simulación activa vive en las rutas raíz. Cualquier otra sesión (replay o simulación archivada) vive bajo `/s/[sessionId]/…` con los mismos cinco destinos pegados a ese contexto, una banda superior fija ("Replay · 90 días · 2 ago → 31 oct" o "Simulación archivada · 14 oct → 20 oct", con "Volver a la simulación actual"), sin refresco periódico, sin acciones sobre el bot (ni Pausar, ni Cerrar ahora, ni fijar/excluir, ni controles de aprendizaje), Ajustes en sólo lectura, y copy en pasado ("Hubiera ganado US$ 412,30 en 90 días.", "Abiertas al final", y el reporte de la sección 9 en lugar del estado del bot).

1. **Resumen**
   - Titular en castellano con el número adentro. El número es `equity − capitalInicial` (lo que quedaría si se cerrara todo ahora): "Vas ganando **US$ 247,80** desde el 14 de octubre." / "Vas perdiendo **US$ 31,20** desde el 14 de octubre." / "Estás igual que el 14 de octubre." / "Todavía no abrí ninguna operación." Si el signo del total difiere del realizado: "Vas ganando US$ 195,70, aunque las abiertas van perdiendo US$ 52,10." "Desde" usa "hoy a las 10:15" / "ayer" / la fecha.
   - Línea secundaria: "Cerrado +247,80 · abierto −52,10 · hoy +38,20 · 14 de 23 ganados". "Hoy" = desde las 00:00 de Buenos Aires, realizado más variación de las abiertas desde ese momento.
   - Veredicto (una línea): "Con 23 operaciones todavía no se puede saber si tiene ventaja; faltan 77." o "Con 140 operaciones en 45 días: ventaja positiva (expectativa +0,21R, 95% de confianza)." o "Con 140 operaciones: sin ventaja demostrada." Criterio en 11.6.
   - Curva de equity (incluye abiertas) con rangos (hoy, 7 días, 30 días, todo; por defecto 7 días; en replay "todo"), saldo como línea fina opcional, sombra apagada por defecto, huecos > 5 minutos en punteado, tocar y mantener muestra fecha y valor en una etiqueta encima.
   - Abiertas ahora: filas con símbolo, lado y apalancamiento, resultado en vivo; **tap** abre la hoja de detalle (transición compartida `layoutId` del bloque símbolo+chip+resultado hacia la cabecera de la hoja); **deslizar a la izquierda** revela "Cerrar ahora" (histéresis de 10px, se cancela si el gesto se vuelve vertical). Sin carrusel.
   - Tu capital, tres estados: (1) antes del blindaje: "A US$ 452 de blindar los US$ 1.000 iniciales" + barra + "Cuando la ganancia llegue a US$ 700 (70%), el bot sigue sólo con lo ganado."; (2) blindado: "Blindaste los US$ 1.000 iniciales el 20 de octubre. El bot opera con US$ 312."; (3) blindado y pausado solo: "El bot se pausó: los US$ 1.000 están blindados y no queda ganancia para operar." + "Volver a usar el capital blindado". Debajo, en los tres: reinversión ("sí · cada operación se calcula sobre US$ 1.312" / "no · siempre sobre US$ 1.000" / "no aplica mientras el capital esté blindado") y "capital blindado en riesgo" si corresponde.
   - Lo último que hizo: encabezado con el tramo ("Desde anoche: 4 operaciones, 3 ganadas, +US$ 22,10. Miré 30 monedas 32 veces."), 5 entradas y "Ver todo" (hoja con el día agrupado). Entran: aperturas, cierres, ajustes de stop, funding relevante (> 0,1% del margen), pausas, cambios de aprendizaje, liquidaciones (destacadas con fondo de pérdida tenue y una banda bajo el titular hasta tocarla: "Hubo 1 liquidación desde ayer"), cierres por "stop no ejecutado por bot sin conexión" (destacados), y "esperé" sólo cuando `|S'| ≥ θ − 0,1` y hubo bloqueo por filtro, máximo una por moneda cada 4 horas.
   - Estado del bot como chips con frase: "En vivo · último ciclo 14:32", "Pausado por vos desde las 13:10", "Pausado solo: capital blindado", "Pausado solo: drawdown del 15%", "Aprendizaje congelado", "BTC muy volátil: opera con la mitad del tamaño", "Pérdida diaria alcanzada: sin entradas hasta mañana", "2 monedas sin datos", "Calentando · 18 de 30 monedas", "Esperando el turno (otra instancia tiene el control)". Botón "Pausar" que abre una hoja con "Pausar (sigo cuidando las 3 abiertas)" y "Pausar y cerrar todo"; "Reanudar" cuando está pausado.
   - **Sin conexión** (sin latido hace más de 60 s), en todas las pantallas: banda bajo el titular o la cabecera ("Bot sin conexión desde las 14:32. Precios y resultados son de ese momento."); todo valor que dependa del precio en color apagado con la hora del último snapshot; el titular usa el realizado y aclara "con las abiertas valuadas a las 14:32"; acciones sobre el bot deshabilitadas con explicación; `<title>` de la pestaña "● Sin conexión · Sereno"; hueco en la curva.
   - **Primer uso**: formulario de dos pasos (capital inicial y blindaje con vista previa en frase viva; modo con una frase por opción, "el bot decide todo" preseleccionado; paso 3 "arrancar con lo aprendido en…" sólo si hay replays) y "Empezar a simular". Después: "Simulación lista. El bot todavía no corre: en la Mac, `pnpm bot`." (sin latido) → "Calentando · 18 de 30 monedas" → "Mirando el mercado. Todavía no abrí ninguna operación." Vacíos en las otras pestañas: "Acá van a aparecer las operaciones cerradas", "El tablero se llena cuando el bot conecte", "Todavía no aprendí nada: necesito trades cerrados".

2. **Posiciones**
   - Abiertas: en desktop tabla con numerales tabulares; en celu tarjeta de tres líneas: "SOL · Long 5x · +US$ 12,40 (+4,1%)", "entró a 142,10 · ahora 148,30 · 3 h", y una barra horizontal stop ─●── TP con el precio actual como punto y la liquidación como marca fuera. "Cerrar ahora" con confirmación.
   - Cerradas: historial agrupado por día con filtros por moneda, lado, resultado y "liquidadas".
   - Estadísticas: ganados y perdidos, tasa de acierto, factor de beneficio, expectativa en R, ganancia y pérdida medias, mejor y peor trade, drawdown máximo (con su resolución), comisiones, spread, slippage y funding totales, costo medio / riesgo medio, liquidaciones, y por moneda (en celu lista de filas "SOL · 6 trades · 4 ganados · +US$ 31,20" ordenable por un segmento; en desktop tabla). La tarjeta de veredicto completa (11.6).
   - Hoja de detalle de un trade: gráfico de velas (lightweight-charts) con entrada, stop, take profit y salida marcados; las señales con valor y peso en barras; el motivo; la línea de tiempo de eventos; costos.

3. **Monedas** (el tablero): baldosas de dos líneas (símbolo sin prefijo "1000", con elipsis; cambio 24h o chip "L 5x"/"S 3x") y la barra de inclinación de short a long abajo. Grilla: 3 columnas en celu (2 bajo 360px), 5 en tablet, 6 en desktop. Orden: primero con posición, después por `|S'|`. Estados: con posición = borde de 1,5px en ganancia/pérdida y fondo `#E1EEE8`/`#F5E5E1` (oscuro: los del mockup Tablero); degradada (sin datos) con punto gris y "sin datos hace 3 min"; en enfriamiento con "espera 45 min"; en penitencia atenuada con la fecha de vuelta. Tocar abre la hoja de la moneda: puntaje desglosado por señal (barras), gráfico, estadísticas de la moneda, confianza aprendida y pesos, fijar o excluir.

4. **Aprendizaje**: qué cambió (diario con tamaños muestrales, "juntando datos: 23 de 50" al principio); originales contra aprendidos (dos curvas, diferencia en puntos porcentuales de I₀ y suma de R, aviso si la sombra viene ganando; "punto de partida" si hubo pre-entrenamiento); señales (fiabilidad = correlación con el retorno a 4h, acierto en trades, peso actual); monedas (confianza y penitencias); parámetros vigentes con la fecha del último cambio y los rechazados; controles (congelar con deshacer, reiniciar con confirmación); replays y simulaciones archivadas (lista con resumen y estados de progreso con "Cancelar"; "Correr un replay" con formulario corto; si el bot está sin conexión, el replay queda en cola y lo dice).

5. **Ajustes**: Capital (inicial sólo al crear; blindaje con vista previa "Cuando la ganancia llegue a [70]% (US$ 700), blindo los US$ 1.000 iniciales y sigo sólo con lo ganado."; qué hacer con las abiertas al blindar; reinversión; "Volver a usar el capital blindado"). Modo: "El bot decide todo" / "Yo fijo tamaño y salidas", con la aclaración "En los dos casos el bot elige cuándo entrar y si es long o short"; en el segundo aparecen margen por trade, apalancamiento, TP, SL (con traducción en vivo "SL 2% del precio = −US$ 5 de los US$ 50 (−10%)" y validación contra la liquidación), trailing, posiciones máximas, dirección. Riesgo (avanzado): riesgo por trade, apalancamiento máximo, posiciones máximas, margen máximo, nocional máximo, cortes de pérdida, comisiones, tabla de mmr; valores por defecto visibles y "restablecer". Universo: top N, fijadas, excluidas, incluir TradFi, símbolos fuera por mínimo. Bot: pausar, cerrar todo (confirmación con el total: "Vas a cerrar 3 posiciones por −US$ 8,40"), nueva simulación (confirmación: "La actual queda guardada y la podés volver a ver. Las 3 abiertas se cierran al precio actual."). Modo real: apagado, qué falta, y "todo lo de esta simulación es ficticio". Cuenta: email y cerrar sesión.

Confirmaciones sólo para lo destructivo (cerrar ahora, cerrar todo, nueva simulación, reiniciar aprendizaje, volver a usar capital blindado). Lo demás con toast "Deshacer" de 6 segundos (pausar/reanudar, congelar aprendizaje, cambios de ajustes; deshacer escribe el valor anterior en `settings`).

### 11.2 Diseño visual

Tokens (de los mockups aprobados):

| Token | Claro | Oscuro |
|---|---|---|
| fondo | `#EDF0F4` | `#0F1318` |
| superficie | `#FFFFFF` | `#171C24` |
| tinta | `#17202A` | `#E8ECF1` |
| apagado | `#6B7482` | `#8A93A3` |
| línea | `#DFE3E8` | `#262D38` |
| ganancia | `#2E8B6A` | `#4FD1A5` |
| pérdida | `#C4553D` | `#FF7A7A` |
| ganancia tenue (fondos) | `#E1EEE8` | `rgba(79,209,165,.14)` |
| pérdida tenue (fondos) | `#F5E5E1` | `rgba(255,122,122,.14)` |

- Tipografía: **Instrument Sans** (variable, vía `next/font`) para todo; numerales proporcionales en el titular y los números grandes, `tabular-nums` sólo en columnas y filas alineadas. Titular con tracking −0,02em y altura de línea 1,2; cuerpo tracking 0 y 1,5. Tamaños en `rem`.
- Modo oscuro automático según el sistema, mismos tokens. `prefers-reduced-transparency` ⇒ barra sólida con línea.
- Radio 14px en paneles, 999 en chips. Sin sombras decorativas. Columna de 640px; en ≥ 900px "Abiertas ahora" y "Tu capital" van lado a lado (1,3fr / 1fr) como en el mockup; el tablero usa el ancho completo.
- Etiquetas en oración, nunca en mayúsculas; sin eyebrows; sin flechas decorativas; moneda "US$" en titular, balance y ajustes, sólo el número en listas densas con la unidad en el encabezado.
- Copy en rioplatense, voseo, verbos activos ("Pausar bot", "Cerrar ahora", "Correr un replay"); errores que dicen qué pasó y qué hacer; vacíos que invitan a actuar.
- Gráficos según el skill `dataviz`: líneas de 2px, área al 10%, grilla hairline sólida, hero figure en la misma sans, sin ejes dobles, tooltips que no son la única forma de leer un valor, tabla equivalente disponible.
- PWA: manifest, `viewport-fit=cover`, `safe-area-inset-bottom` en la barra, `theme-color` por esquema, refresco al volver a primer plano.

### 11.3 Movimiento

- Biblioteca: Motion (`motion/react`). Springs críticamente amortiguados (bounce 0, duración 0,3–0,4 s) por defecto; bounce 0,2 sólo al soltar un gesto.
- Hojas en celu: suben desde abajo, se arrastran para cerrar con seguimiento 1:1 desde la cabecera/asa o desde contenido con scroll en el tope y movimiento inicial vertical (> 10px, ángulo > 45°); al soltar se proyecta el destino con `project(v) = (v/1000)·0,998/(1−0,998)` y se cierra si el punto proyectado pasa el 50% o la velocidad hacia abajo supera 500 px/s, si no vuelve con spring bounce 0,2 y la velocidad del dedo; rubber-band (constante 0,55) por encima del tope; mismo camino de entrada y salida; scrim que escala la página a 0,98 sólo en celu; se puede agarrar en mitad de la animación. En desktop (≥ 900px) el mismo componente es un panel centrado de 560px con scrim (escala 0,96→1 y fundido), cierra con Esc, clic afuera o arrastre hacia abajo.
- El gráfico dentro de una hoja captura cualquier gesto que empieza sobre él; en celu, scroll vertical del gráfico desactivado y altura fija de 220px.
- Transición compartida fila → hoja (`layoutId`).
- Números: interpolar sólo si el cambio es menor al 5% del valor y la pestaña estuvo visible en los últimos 30 s; si no, cambio directo con fundido de 150 ms. Duración 250 ms, spring sin rebote. El verbo del titular cambia con crossfade del texto completo al cruzar cero.
- Baldosas: la barra de inclinación se anima al cambiar; al abrir una posición la baldosa "late" una vez.
- Una sola secuencia de entrada en Resumen (titular, luego curva, luego listas, 40 ms de escalonado), sólo en la carga inicial, no al cambiar de pestaña.
- Respuesta al toque en pointer-down (escala 0,97). `prefers-reduced-motion`: fundidos en vez de desplazamientos, sin rebote, sin latido, números con fundido, secuencia de entrada como un fundido único; las hojas siguen arrastrables pero cierran con fundido.
- Barra inferior translúcida con el contenido pasando por detrás, sin línea dura.

### 11.4 Carga, error y datos viejos

- Cada pantalla tiene esqueleto con la misma geometría (titular de dos líneas, rectángulo de curva, tres filas). Al refrescar, la pantalla conserva los últimos datos (`placeholderData: keepPreviousData`); nunca una pantalla en blanco.
- Error de lectura: banda "No pude leer la base. Último dato 14:32. [Reintentar]" con los últimos datos visibles.
- Acciones: escriben en la base y muestran "enviado al bot… ✓ aplicado" cuando `bot_status.settingsVersionApplied` coincide o el comando pasa a `done`. Comandos sensibles al precio vencen a los 60 s: "El bot no respondió. No cerré SOL. [Reintentar]"; mientras espera, "Cancelar" borra el comando. Los ajustes muestran "Guardado · el bot lo toma cuando vuelva" si no hay latido.

### 11.5 Datos en vivo

- Un solo endpoint `GET /api/live?since=<version>` (Route Handler, Node) devuelve en una consulta: `market_snapshot`, posiciones abiertas, `bot_status`, última fila de equity, settings version, y responde `{ unchanged: true }` cuando nada cambió. TanStack Query: 5 s con la pestaña visible y el bot en vivo; 30 s si está pausado o sin conexión; pausa con `document.visibilityState`; refresco al volver a la pestaña. Las lecturas pesadas (historial, estadísticas, aprendizaje) son Server Components con revalidación por pestaña.
- Validación con zod compartida con el bot. Server Actions para ajustes y comandos; `requestedBy` = email de la sesión.

### 11.6 Veredicto

El criterio de Toti ("gana más de lo que pierde de forma sostenida") hecho estadística (decisión mía, mostrada tal cual en la UI): se puede evaluar a partir de **100 trades cerrados y 30 días**. Veredicto "ventaja positiva" si la expectativa por trade en R es > 0 con 95% de confianza (bootstrap de 2.000 remuestreos), el factor de beneficio ≥ 1,3, el drawdown máximo ≤ 15% y lo aprendido no está por debajo de la sombra en más de 3 puntos porcentuales. "Sin ventaja demostrada" en cualquier otro caso, con la razón ("expectativa +0,05R, intervalo que incluye 0"). Antes de la muestra mínima: "todavía no se puede saber; faltan N". Aplica igual a replays.

### 11.7 Acceso

- Better Auth con adaptador Drizzle (`provider: 'pg'`) sobre Neon. Dos formas de entrar, ambas limitadas a la lista `ALLOWED_EMAILS`: **Google** (gateada en credenciales, siguiendo `marrona-google-auth`: `socialProviders.google` sólo si hay `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET`) y **email + contraseña** (sin alta pública: `disableSignUp`; el usuario autorizado se crea con un script de seed que lee `DASHBOARD_PASSWORD` del entorno local; es el camino para entrar hasta que Toti registre el callback de Google). La lista blanca se aplica en `databaseHooks.user.create.before` y en la validación del perfil OAuth en cada inicio de sesión (`user.validateUserInfo` o el hook equivalente de la versión instalada), así cambiar la lista no requiere tocar la base. Account linking con `trustedProviders: ['google']` y `requireLocalEmailVerified` por defecto.
- Pantalla de entrada: nombre, una frase ("Dashboard del bot. Sólo para la cuenta autorizada.") y los botones disponibles; rechazo: "Esta cuenta no tiene acceso a Sereno" + "Probar con otra cuenta".
- `proxy.ts` sólo chequea la cookie; cada página y handler valida con `auth.api.getSession`. Las acciones registran quién y cuándo.

## 12. El proceso del bot (`apps/bot`)

- `pnpm bot` (envuelto en `caffeinate -i`) arranca el modo en vivo: toma el lease (o espera), carga settings y aprendizaje, reconstruye el estado de posiciones y órdenes abiertas desde la base (idempotente ante reinicios), refresca `symbols` y el universo, calienta velas por REST encolando ≤ 150 llamadas de peso 10 por minuto, abre **una** conexión a `wss://fstream.binance.com/market/stream?streams=…` con `kline_15m`, `kline_1h`, `kline_4h` y `markPrice@1s` de los 30 símbolos (120 streams), y entra al bucle. El spread se lee por REST (`bookTicker`) sólo al ejecutar una orden.
- Websocket: reconexión programada a las ~23 horas en un momento tranquilo (nunca en el cierre de una vela de 15m), pong proactivo, cola de SUBSCRIBE ≤ 5 mensajes por segundo, backoff en desconexiones; al reconectar vuelve a pedir por REST las velas perdidas (`klines` con `startTime`) antes de reanudar decisiones. Si pasan más de 60 s sin datos de un símbolo, lo marca degradado. Cierre de vela: `x = true` del kline, confirmado contra el reloj.
- Programador: cierres de vela (plazo de 3 s), datos de futuros cada 5 minutos, universo y limpieza a las 00:05 UTC, ajuste de parámetros los domingos 00:30 UTC, retorno a 4h/24h de las decisiones cada hora, latido + lease cada 10 s, snapshot de mercado cada 5 s (un solo UPSERT), comandos cada 3 s, equity por minuto y por evento.
- Estados: `starting`, `warming`, `live`, `paused`, `waiting_lease`. En `paused` aplica la semántica de la sección 7.
- Reinicio después de un hueco: reconstruye el estado y reevalúa las abiertas con el precio actual; si pasó el stop, cierra al precio actual con motivo "stop no ejecutado por bot sin conexión" (destacado en el diario).
- Logs estructurados (pino); errores recientes en `bot_status`. `pnpm bot replay --days 90 --capital 1000` corre un replay por línea de comandos; los replays también se disparan por comando desde el dashboard y corren en un worker thread.
- Dockerfile listo para el worker futuro. Variables: `DATABASE_URL_UNPOOLED`, `LOG_LEVEL`, opcionales `BINANCE_API_KEY`/`BINANCE_API_SECRET` (sólo lectura o modo real futuro). `TZ` queda en UTC.

## 13. Despliegue

- `apps/web` en Vercel (proyecto `sereno`, root `apps/web`, build con Turborepo). Variables: `DATABASE_URL`, `DATABASE_URL_UNPOOLED` (migraciones desde el repo, no desde Vercel), `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `ALLOWED_EMAILS`, opcionales `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. Declaradas en `turbo.json` `globalEnv` y en `.env.example`. Presupuesto: con un solo endpoint de polling y respuestas `unchanged`, un usuario con la pestaña abierta 8 h/día consume ~500.000 invocaciones y bajo egress al mes; cuestión Hobby vs Pro en `preguntas.md`.
- Base en Neon provisionada según `marrona-neon-db` (SQL path). Migraciones con Drizzle.
- Bot: hoy local con `pnpm bot`; después un VPS que pase el gate de Binance. Cuándo mudarlo lo decide Toti.
- `.gitignore` con `.superpowers/`, `node_modules`, `.env*` (salvo `.env.example`), `.next`, `dist`, `.turbo`.

## 14. Calidad y pruebas

- `packages/core` con Vitest y TDD: indicadores contra valores conocidos (fixtures calculados a mano o con una referencia), causalidad (un fixture donde una vela de 4h abierta entraría al cálculo tiene que fallar), señales (rango, señales ausentes fuera del promedio, Donchian excluyente), tamaño y apalancamiento (invariante de liquidación, mínimos, step, piso por costo, multiplicadores sólo reductores), simulador (comisiones, funding por evento con precio de marca, liquidación con la fórmula exacta, órdenes de stop/TP, orden canónico intra-vela, fills de replay con spread y slippage), capital (blindaje con `min(realizado, equity − base)`, reducción al blindar, pausa por capital insuficiente, volver a usar, reinversión, cortes diarios/drawdown/racha/concentración, pausa que sigue cuidando salidas), aprendizaje (actualizaciones, topes semanales, encogimiento, penitencia, congelamiento hasta 50, walk-forward con hold-out y permanencia), sombra, veredicto (bootstrap determinista con semilla), replay determinista (mismo fixture ⇒ mismo resultado, byte a byte), diario (frases exactas).
- `apps/bot`: pruebas de integración con un Binance falso (fixtures grabadas de REST y del stream `/market`) para calentamiento, cierre de vela con plazo, reconexión con relleno de velas, limitador de tasa, claim atómico de comandos, lease, reconstrucción tras reinicio.
- `packages/db`: migraciones aplican en limpio; repositorios contra un Postgres de prueba (Neon branch o local).
- `apps/web`: pruebas de componentes para formato es-AR y titular (todas las variantes), formularios de ajustes (traducción de SL/TP, validaciones), estados (sin conexión, replay, vacíos); una prueba end-to-end de humo con Playwright (login con contraseña, Resumen carga, pausar escribe en settings).
- Revisión visual en desktop y en viewport de celu (375px) de cada pantalla, con `prefers-reduced-motion` activado y desactivado, antes de dar por terminada; capturas guardadas en `docs/superpowers/review/`.

## 15. Lo que queda a criterio del builder

- Columnas exactas, índices y nombres de columnas; estrategia de migraciones.
- Organización interna de `packages/core` (módulos, nombres), siempre que quede sin IO, determinista y con la regla de causalidad en el tipo `MarketView`.
- Modelado del reloj simulado y la cola de eventos del replay.
- Componentes de UI propios sobre Tailwind v4 (shadcn sólo como primitivas de formulario si ahorra tiempo), siempre con los tokens de 11.2.
- Detalles de hojas, gestos y transiciones dentro de 11.3.
- Estructura de pruebas y fixtures.
- Orden de implementación (sugerido en el plan).

## 16. Preguntas abiertas para Toti

Están en `preguntas.md` con la decisión provisional tomada para cada una (hosting del worker, plan de Neon y Vercel, tamaño real de capital, TradFi en el universo, aviso por email cuando el bot cae, GitHub, nombre).

## 17. Decisiones mías para revisar

1. Tamaño por riesgo (1% del capital base, sólo reducible) y apalancamiento derivado del stop (liquidación a ≥ 3 stops), apalancamiento máximo 5, hasta 5 posiciones, 3 por dirección.
2. Universo top 30 por volumen con filtros de `exchangeInfo` (sólo cripto, 60 días de historia); velas de 15m con filtro de 1h y 4h; ATR de 1h.
3. Salidas en R: stop a 1,5 ATR (piso 8 × costo), TP a 2R, trailing a 1R desde +1R, salida por señal y por tiempo a 48 horas; órdenes de stop y TP que viven en el exchange.
4. Cortes a nivel cuenta: 3% diario, 15% de drawdown, 6 stops seguidos, 3 por dirección.
5. Blindaje con `min(realizado, equity − base)`, reducción de abiertas al blindar, re-base al volver a usar.
6. Aprendizaje con dos vías (trades y decisiones no tomadas), topes semanales, encogimiento, congelado hasta 50 trades, walk-forward semanal con hold-out, cartera sombra con los valores por defecto.
7. Replay a 15 minutos con velas de marca y peor caso intra-vela; universo recalculado por día; sesgo de supervivencia declarado.
8. Control del bot a través de la base con claim atómico, vencimiento, idempotencia, lease de instancia única y versión de settings.
9. Veredicto estadístico con 100 trades y 30 días.
10. Nombre "Sereno"; Instrument Sans; capital sugerido US$ 1.000; PWA; email + contraseña como camino de entrada hasta que exista el callback de Google.
11. Bot en la Mac con `caffeinate`; Railway descartado; gate de Binance para cualquier host futuro.
