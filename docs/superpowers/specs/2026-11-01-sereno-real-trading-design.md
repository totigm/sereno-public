# Sereno — operación con plata real (diseño)

Fecha: 1 de noviembre de 2026. Complementa el diseño principal
`docs/superpowers/specs/2026-10-31-sereno-trading-bot-design.md` (en adelante "el spec"), que ya
preveía esto: "Mismo código para simulado y real: una interfaz `Exchange` con `PaperExchange` hoy y
`BinanceFuturesExchange` mañana" (§2.7, §6). Las decisiones marcadas **[decisión mía]** las tomé yo
porque Toti pidió no hacer preguntas; él puede revertirlas al leer.

## Intención

Toti quiere probar el bot con muy poca plata real (US$ 10–50) en futuros USDT-M de Binance,
**mientras la simulación de US$ 1.000 sigue corriendo**, para ver cómo se comporta con fills,
comisiones y funding de verdad. El objetivo no es ganar plata con esto todavía: es aprender, con una
pérdida máxima chica y conocida de antemano.

Lo que más importa: que **nunca pueda perder más de lo que Toti asignó**, que toda posición abierta
tenga **siempre un stop puesto en Binance** (aunque se caiga el bot o la Mac), y que el modo real
**no se pueda prender por accidente**.

## Metas

1. Una sesión de tipo **real** que corre al mismo tiempo que la sesión en papel, con el mismo motor
   (señales, decisión, tamaño, salidas, blindaje, aprendizaje) y un exchange que habla con Binance.
2. **Capital asignado**: Toti elige cuánto usa la sesión real (p. ej. US$ 50). El bot opera como si
   la cuenta tuviera sólo eso, aunque la billetera de futuros tenga más.
3. **Tope de pérdida duro** de la sesión real (por defecto 50% del capital asignado **[decisión mía]**,
   configurable entre 10% y 100%): si la equity de la sesión cae a `capital × (1 − tope)`, cierra todo
   a mercado, cancela sus órdenes y queda **apagada** hasta que Toti la vuelva a prender a mano.
4. **Interruptor**: "Cerrar todo y apagar" en el dashboard y por línea de comandos
   (`pnpm bot real-off`), que funciona aunque el dashboard no ande.
5. Los números que muestra el dashboard para la sesión real salen de Binance (fills, comisiones,
   funding, pnl realizado), no de la simulación.
6. Un **modo testnet** (Binance Futures Testnet, `testnet.binancefuture.com`) que usa exactamente el
   mismo código con claves de prueba, para probar todo sin plata antes de usar la real.

## No metas

- Spot, margin, retiros, transferencias entre billeteras (Toti mueve la plata a la billetera de
  futuros USDT-M a mano).
- Modo cobertura (hedge mode): sólo modo de una posición por moneda (one-way).
- Margen cruzado: siempre **aislado**, como el spec.
- Varias cuentas o subcuentas.
- Correr el bot real fuera de la Mac (el deploy sigue diferido).
- Cartera sombra en la sesión real: la comparación vive en la sesión en papel **[decisión mía]**.

## Anti-metas (si pasa esto, falló aunque "ande")

- Una posición real sin stop en Binance por más de unos segundos.
- El bot usando más margen que el capital asignado, o abriendo después de tocar el tope de pérdida.
- Que una variable mal puesta, un reinicio o un error deje el modo real prendido sin que Toti lo
  haya pedido explícitamente para esa sesión.
- Que el bot toque posiciones u órdenes que no abrió él (Toti puede operar a mano en la misma cuenta).
- Una clave con permiso de retiro, o un secret escrito en logs, en la base o en el dashboard.
- Que la sesión en papel se frene o se degrade por culpa de la real (o al revés).

## Cómo se prende (todas las llaves, en orden)

1. **Claves de operación aparte** en el `.env` de la raíz: `BINANCE_TRADE_API_KEY` y
   `BINANCE_TRADE_API_SECRET` (la de sólo lectura actual queda como está). Las carga Toti; el bot
   nunca las muestra.
2. **Variable de entorno** `SERENO_REAL_TRADING=on` (y `BINANCE_ENV=testnet|mainnet`, por defecto
   `testnet` **[decisión mía]**: para usar plata de verdad hay que escribir `mainnet` a propósito).
3. **Chequeos al arrancar**, si alguno falla la sesión real no arranca y el dashboard dice cuál:
   - la clave tiene futuros habilitados y **no** tiene retiros habilitados
     (`GET /sapi/v1/account/apiRestrictions`; en testnet ese endpoint no existe: se saltea y se dice);
   - la clave está restringida por IP (`ipRestrict = true`) en mainnet;
   - la cuenta está en modo one-way (`GET /fapi/v1/positionSide/dual` → `false`);
   - la billetera de futuros tiene al menos el capital asignado disponible;
   - la hora local está a menos de 1 s de la de Binance;
   - el modo multi-activos está apagado (`GET /fapi/v1/multiAssetsMargin` → `false`);
   - el descuento de comisiones con BNB está apagado (`GET /fapi/v1/feeBurn` → `false`): así las
     comisiones se cobran en USDT y la cuenta de la sesión cierra con la billetera **[decisión mía]**;
   - el `BINANCE_ENV` de la sesión guardada coincide con el del entorno (una sesión creada en testnet
     nunca opera en mainnet ni al revés).
4. **Crear la sesión real desde el dashboard** (Ajustes › Plata real), con el capital asignado, el
   tope de pérdida y una confirmación escribiendo el monto ("50"). Sin los pasos 1–3 en verde el
   botón está apagado y explica qué falta (cumple el "la UI muestra el modo real apagado y explica
   qué falta" del spec §6).

Si cualquiera de las llaves 1–2 desaparece en un reinicio, la sesión real **no abre nada**: queda en
"apagada: falta X" **[decisión mía]**:
- **Sin `SERENO_REAL_TRADING=on` pero con claves**: el bot sigue cuidando las abiertas con órdenes que
  **sólo reducen riesgo**: mover el stop a favor (trailing, blindaje), salidas del motor (tiempo,
  señal), cortes de cuenta y tope de pérdida, cancelar la orden hermana después de un cierre. Nunca
  abre ni agranda.
- **Sin claves**: lo único que protege son los stops y TP que ya están en Binance; el dashboard lo
  dice en rojo.
- `pnpm bot real-off` funciona sin la variable (sí necesita las claves).

## Cómo funciona

### El exchange real

El motor hoy depende de `SimulatedExchange` (`packages/core/src/exchange/types.ts`): además del
contrato `Exchange`, el simulador le devuelve de forma síncrona los disparos (`processTick` →
`TriggeredOrder[]`) y el funding (`applyFunding` → `FundingApplied[]`). Con Binance esos hechos
llegan por el **user data stream** (`ORDER_TRADE_UPDATE`, `ACCOUNT_UPDATE`, más los eventos de
liquidación).

Diseño: un adaptador real que implementa la forma que el motor necesita, alimentado por el user
data stream: los cierres de stop/TP/liquidación y el funding que Binance informa se encolan y se
entregan al motor por el mismo camino por el que hoy llegan los del simulador. Cómo encajarlo
(implementar `SimulatedExchange` con esa cola, o generalizar la interfaz del motor) **queda al
constructor**, con dos condiciones: la sesión en papel y el replay no cambian su comportamiento
(los tests actuales de determinismo siguen verdes sin tocarlos), y el motor no sabe si es real.

Reglas del adaptador:

- Antes de abrir en una moneda: `marginType = ISOLATED` y el apalancamiento del plan
  (`setLeverage`). Si Binance rechaza, no se abre y el diario lo dice.
- Entrada a mercado; inmediatamente después del fill, **stop `STOP_MARKET` y TP
  `TAKE_PROFIT_MARKET` con `reduceOnly=true`, la cantidad exacta de la posición del bot y
  `workingType=MARK_PRICE`**. Desde diciembre de 2025 Binance acepta esos tipos sólo por la **API de
  órdenes algorítmicas** (`POST /fapi/v1/algoOrder`, cancelación `DELETE /fapi/v1/algoOrder`,
  consulta `GET /fapi/v1/openAlgoOrders`, eventos `ALGO_UPDATE` en el user data stream; las de
  `/fapi/v1/order` se rechazan con −4120). El constructor verifica los campos exactos contra la
  documentación vigente antes de escribir el adaptador y el Binance falso.
  No se usa `closePosition=true` **[decisión mía]**: cerraría también una parte que Toti haya sumado a
  mano (en modo one-way Binance junta las dos) y no permite dos stops a la vez.
  Si el stop no se puede poner tras los reintentos, **se cierra la posición a mercado** en el acto.
- Mover el stop (trailing, blindaje): primero se pone el nuevo, después se cancela el viejo (con
  `reduceOnly` y cantidad explícita se pueden tener los dos un instante).
- Cantidades y precios redondeados a `stepSize`/`tickSize` del contrato; `minNotional` y `minQty`
  se respetan (el sizing ya lo hace, spec §5).
- Toda orden lleva un id de cliente con prefijo `sereno-<sesión corta>-` (`newClientOrderId` en las
  de mercado, `clientAlgoId` en las algorítmicas). **Qué es del bot lo decide su propio registro**
  (la base), no Binance: Binance no le pone id a las posiciones. Una orden de mercado que nace al
  disparar un stop/TP del bot es del bot (se vincula por el id de la orden algorítmica).
- **Propiedad por moneda:** el bot sólo opera monedas donde, al abrir, Binance no tiene posición. Si
  Toti tiene algo abierto en esa moneda, no abre ("tenés una posición tuya en SOL; no la toco"). Si
  la cantidad en Binance deja de coincidir con la del bot (Toti sumó o restó a mano), el bot gestiona
  **sólo su cantidad** (sus órdenes son `reduceOnly` por esa cantidad), no abre más en esa moneda
  hasta que quede en cero, y el diario lo avisa. Nunca cierra más que su cantidad.
- Los números (precio de fill, comisión, pnl realizado, funding) se toman de lo que informa Binance.
- Errores de Binance se clasifican (reintentable / rechazo / fatal); los rechazos van al diario en
  castellano, los fatales apagan la sesión real (cerrando lo que se pueda).

### Reconciliación

Al arrancar y cada minuto **[decisión mía]**: se comparan las posiciones y órdenes abiertas en Binance
(las del prefijo) con lo que la base cree.

- Posición en Binance sin stop ⇒ se pone el stop guardado (o, si no hay, uno a `k·ATR`); si no se
  puede, se cierra.
- Posición en la base que en Binance ya no está ⇒ se registra el cierre con el fill real
  (`/fapi/v1/userTrades`), motivo según la orden que la cerró, o "cerrada en Binance" si no se sabe.
- Posición que la base no conoce (bot caído entre el fill y el guardado) ⇒ se adopta **sólo** si hay
  un fill con el prefijo de la sesión en `/fapi/v1/userTrades` que la explique, con su precio de
  entrada real y su cantidad, y se le pone stop. Si no, es de Toti y no se toca.
- El user data stream se reconecta solo y renueva su `listenKey` cada 30 min; mientras está caído,
  la reconciliación por REST cubre.

### Capital, tope e interruptor

- La sesión real usa su `capitalInicial` = capital asignado y la contabilidad del spec (saldo,
  equity, blindaje, reinversión). El margen en uso nunca supera `capitalOperable` de la sesión,
  aunque la billetera tenga más.
- **Tope de pérdida**, en dos capas **[decisión mía]**:
  1. *Al abrir* (garantía por tamaño): no se abre un trade si la pérdida en el peor caso de todas las
     abiertas a sus stops más la del nuevo (con el slippage supuesto y las comisiones) puede bajar la
     equity del piso `capitalInicial × (1 − tope)`. Esto es una regla nueva del motor puro, que en
     papel y replay queda apagada (tope = 100%), así no cambia nada de lo actual.
  2. *En marcha*: si la equity (saldo + no realizado a precio de marca) toca el piso, se cierra todo,
     se cancelan las órdenes del bot y la sesión queda "apagada por el tope de pérdida".
  Lo que el diseño no puede prometer: un hueco de precio que salte el stop puede pasar el piso; el
  margen aislado acota cada posición a su margen. El dashboard lo dice así, sin exagerar.
- **Volver a prender después del tope** = **crear una sesión real nueva** con un capital asignado
  nuevo (escribiendo el monto). La anterior queda cerrada con su historia. Así "perder como mucho lo
  asignado" vale por sesión y la contabilidad no se mezcla **[decisión mía]**.
- Los cortes del spec (pérdida diaria, drawdown, stops seguidos) aplican igual.
- **Interruptor** (`real-off`): cierra todo lo del prefijo a mercado, cancela órdenes y apaga la
  sesión. Funciona como comando del dashboard y como CLI que habla directo con Binance (sin depender
  de que el bot esté vivo).

### Cómo conviven las dos sesiones

El bot hoy toma una sesión en vivo con lease. La sesión real corre **en el mismo proceso** que la de
papel **[decisión mía, el constructor puede cambiarla si el runtime lo hace muy difícil]**, para
compartir el presupuesto de peso de la API por IP (2.400/min).

- **Mainnet**: comparte el stream de mercado de la sesión en papel (son los mismos precios).
- **Testnet**: usa **los datos de mercado de testnet** (REST y WebSocket propios; la documentación
  oficial da `testnet.binancefuture.com` y `fstream.binancefuture.com`, el constructor confirma los
  hosts vigentes) y su universo se limita a las monedas que existen en testnet. Así la prueba ejercita
  la lógica real con precios coherentes con las órdenes. En testnet no hay `apiRestrictions` ni
  `feeBurn` confiables: esos chequeos se saltean y se dice. Requisito: un
error en una no tumba a la otra, y el límite de peso se reparte (la real tiene prioridad para
órdenes y reconciliación).

La sesión real arranca con **los ajustes por defecto actuales** (θ 0,55, k 2) y el aprendizaje
desde cero **[decisión mía]**. Toti puede pasarla al modo "yo fijo tamaño y salidas" como cualquier
sesión.

### Dashboard

- Un selector de sesión (papel / real) visible en todas las pantallas; la real lleva una marca
  inconfundible ("Plata real" en color de alerta) en el titular y en la pestaña del navegador.
- Las mismas pantallas (Resumen, Posiciones, Monedas, Aprendizaje, Ajustes) muestran la sesión
  elegida.
- Ajustes › Plata real: la lista de chequeos con su estado, crear/prender/apagar la sesión real,
  tope de pérdida, y "Cerrar todo y apagar".
- El diario dice cuando un número viene de Binance y cuándo hubo una diferencia de reconciliación.

## Restricciones

- Igual que el spec: TypeScript estricto, el motor en `packages/core` sigue puro, la base como única
  fuente para el dashboard, textos en castellano rioplatense.
- Secrets: nunca en logs, base, payloads del dashboard ni mensajes de error. Firmas HMAC con el
  `signing.ts` actual.
- Tests: todo el camino real se prueba contra un **Binance falso** (ya existe uno en
  `apps/bot/src/binance/fake`) que se extiende con órdenes, user data stream, rechazos, fills
  parciales, desconexiones y reinicios. Ningún test toca Binance de verdad.
- Prueba en testnet: el código queda listo para que Toti la corra con claves de testnet; el
  constructor no tiene claves y no corre nada contra Binance real ni testnet.

## Lo que queda al constructor

- Cómo encajar el adaptador en el motor (cola sobre `SimulatedExchange` o interfaz generalizada).
- Cómo correr dos sesiones en el mismo proceso (lanes, leases separados).
- El esquema de base para la sesión real (`session_kind` nuevo, campos del tope y del estado de los
  chequeos) y su migración.
- Los reintentos y tiempos exactos (con los límites de arriba como mínimos de seguridad).
- El detalle visual del selector y de la marca "Plata real", siguiendo el lenguaje actual del
  dashboard.
