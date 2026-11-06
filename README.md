# Sereno

Bot de futuros USDT-M de Binance con paper trading, replay histórico, aprendizaje
explicable y un dashboard web (desktop y celular). Diseño en
`docs/superpowers/specs/2026-10-31-sereno-trading-bot-design.md`; plan de
implementación en `docs/superpowers/plans/2026-10-31-sereno-implementation.md`.

## Estructura

Monorepo con pnpm y Turborepo. Los paquetes internos se consumen desde `src`, sin
paso de build.

- `packages/shared`: configuración (`SettingsSchema`), comandos del bot y vocabulario común.
- `packages/core`: el motor de decisión, puro (sin IO ni reloj).
- `packages/db`: esquema Drizzle, migraciones y repositorios (Postgres / Neon).
- `apps/bot`: el proceso que habla con Binance, corre el motor y persiste.
- `apps/web`: el dashboard (Next.js 16).

## Requisitos

Node 22 y pnpm 12.

```sh
pnpm install
cp .env.example .env   # y completar los valores
```

## Base de datos local

En desarrollo, un Postgres 17 de Homebrew con los datos en `.local/postgres` (ignorada
por git) y en el puerto 5499, el de las URLs de `.env.example`:

```sh
brew install postgresql@17
export PATH="$(brew --prefix postgresql@17)/bin:$PATH"
initdb -D .local/postgres -U postgres --auth=trust   # sólo la primera vez
pg_ctl -D .local/postgres -o "-p 5499" -l .local/postgres.log start
createdb -h 127.0.0.1 -p 5499 -U postgres sereno        # la de desarrollo
createdb -h 127.0.0.1 -p 5499 -U postgres sereno_test   # la de los tests: se vacía en cada corrida
createdb -h 127.0.0.1 -p 5499 -U postgres sereno_bot_test  # la de los tests del bot
createdb -h 127.0.0.1 -p 5499 -U postgres sereno_web_test  # la de los tests de los scripts del dashboard
createdb -h 127.0.0.1 -p 5499 -U postgres sereno_dev       # la de los datos de demostración (pnpm demo)
pnpm db:migrate                                         # migra la de DATABASE_URL_UNPOOLED
```

Los tests de `@sereno/db` y del dashboard usan `DATABASE_URL_TEST` (por defecto
`sereno_test`); los del bot, `DATABASE_URL_TEST_BOT` (por defecto `sereno_bot_test`), así
pueden correr en paralelo con los del dashboard. Los de los scripts del dashboard (`seed:user`,
`seed:demo`) usan `DATABASE_URL_TEST_WEB` y se saltean si no está definida. Los tests migran su base solos; sin este
Postgres levantado fallan al conectar. Para apagarlo:
`pg_ctl -D .local/postgres stop`.

## Primer arranque

```sh
cp .env.example .env                       # el del bot: las URLs de la base local
cp apps/web/.env.example apps/web/.env.local
#   en apps/web/.env.local: BETTER_AUTH_SECRET (openssl rand -base64 32),
#   ALLOWED_EMAILS=owner@example.com y DASHBOARD_PASSWORD (la que vas a usar para entrar)
pnpm db:migrate
pnpm db:seed-user                          # crea tu usuario con esa contraseña
pnpm bot                                   # en una terminal
pnpm --filter @sereno/web dev              # en otra: http://localhost:3000
```

Al entrar por primera vez, Resumen ofrece "Empezar a simular": elegís el capital, el
porcentaje a blindar y el modo. El bot toma la simulación nueva al rato, calcula el universo
del día y decide al cierre de cada vela de 15 minutos.

## Comandos

```sh
pnpm dev                      # dashboard y bot en modo desarrollo
pnpm bot                      # el bot en vivo (paper trading), con supervisor
pnpm bot replay --days 90     # un replay histórico de 90 días por línea de comandos
pnpm db:generate              # genera la migración SQL a partir del esquema
pnpm db:migrate               # aplica las migraciones pendientes
pnpm test                     # todos los tests (Vitest, un proyecto por paquete)
pnpm typecheck                # TypeScript en todos los paquetes
pnpm build                    # build de producción del dashboard
pnpm demo --scenario active   # datos de demostración en sereno_dev (también shielded, offline, first-run, replays)
pnpm e2e                      # prueba de humo con Playwright contra una base _dev (ver docs/superpowers/review/README.md)
```

Un paquete solo: `pnpm --filter @sereno/shared test`.

## Correr el bot 24/7 en la Mac

```sh
apps/bot/bin/sereno-bot.sh    # desde la raíz del repo; dejá la terminal abierta
```

Es el mismo supervisor que corre `pnpm bot`, sin pnpm en el medio. pnpm sale con el primer
Ctrl-C sin esperar: la terminal vuelve enseguida mientras el bot termina de apagarse por detrás
(sus últimas líneas aparecen igual) y un segundo Ctrl-C ya no le llega; para cortarlo hay que
usar el `kill <pid>` que muestra el supervisor. Para un rato, `pnpm bot` sirve; para dejarlo
corriendo, el script directo.

El supervisor:

- arranca el bot en vivo y, si se cae (sale con error), lo relanza solo: espera 1 s, 2 s,
  4 s… hasta 60 s entre intentos, y vuelve a 1 s cuando el bot anduvo bien 10 minutos. Cada
  relanzamiento queda en una línea (`[03:12:45] sereno · el bot salió con código 1; lo
  relanzo en 4 s`). Si el bot termina sin error, el supervisor también termina.
- con Ctrl-C le pide al bot que se apague ordenado: guarda lo pendiente, suelta la sesión y
  recién ahí termina ("el bot se apagó y soltó la sesión"). Un segundo Ctrl-C lo corta en el
  acto; entonces la sesión queda tomada hasta que vence el lease (30 s).
- si cerrás la ventana de la terminal, el bot se corta en el acto, sin apagado ordenado: la
  sesión queda tomada hasta que vence el lease y el supervisor no lo relanza. Para apagarlo,
  Ctrl-C y esperá el aviso.
- lee el `.env` de la raíz antes de cada arranque, sin imprimir valores (lo que ya está en
  el entorno gana): un cambio en el `.env` vale desde el próximo relanzamiento.
- con `apps/bot/bin/sereno-bot.sh replay --days 90` (o `pnpm bot replay --days 90`) corre
  una sola vez, sin relanzar.
- mantiene la Mac despierta con `caffeinate -i -s` mientras corre, también entre
  relanzamientos y durante el apagado.

`-i` evita que la Mac se duerma por inactividad y `-s`, que se duerma el sistema mientras
está enchufada (macOS lo ignora a batería). **Con la tapa cerrada y sin cargador la Mac se
duerme igual** y el bot se pierde velas hasta que la abras; al volver reconstruye el estado y
cierra lo que haya pasado su stop ("stop no ejecutado por bot sin conexión"). La primera vez
que la dejes enchufada con la tapa cerrada, comprobá en el dashboard que siga en vivo. La
pantalla sí se apaga; al bot no le afecta.

En el dashboard, los chips de estado dicen "En vivo · último ciclo 14:30" mientras opera,
"Calentando · 12 de 30 monedas" al arrancar y "Esperando el turno" si otra instancia tiene la
sesión (por ejemplo, otro supervisor en otra terminal). Si el bot pasa más de 60 s sin latir,
todas las pantallas muestran "Bot sin conexión desde las 14:32…" y el título de la pestaña
empieza con "● Sin conexión".

Para un servidor, más adelante: `docker build -f apps/bot/Dockerfile -t sereno-bot .` y
`docker run -d --restart unless-stopped --env-file .env sereno-bot`. El host tiene que pasar
el gate de Binance (`curl https://fapi.binance.com/fapi/v1/ping` devuelve 200 desde su IP).

## Clave de Binance de sólo lectura (opcional)

Sin clave, el bot opera en paper trading con los supuestos del diseño para el margen de
mantenimiento (mmr) de cada moneda y las comisiones. Con una clave de **sólo lectura**, trae
los de tu cuenta: el mmr del primer tramo de cada moneda y tus comisiones taker y maker.

1. En Binance: Cuenta › Gestión de API › Crear API › "Generada por el sistema".
2. Permisos: dejá tildado sólo **"Habilitar lectura"**. Nada de futuros, margen ni retiros:
   el bot no tiene ni va a tener cómo mandar órdenes, pero una clave que sólo lee no sirve
   para nada más aunque se filtre.
3. Restringí el acceso por IP a la de la máquina donde corre el bot.
4. Ponela en el `.env` de la raíz (nunca en el repo):

   ```sh
   BINANCE_API_KEY=...
   BINANCE_API_SECRET=...
   ```

Qué cambia: al tomar la simulación y después todos los días a las 00:10 UTC, el bot pide los
dos datos y, si difieren de los ajustes, los guarda como una versión nueva (queda en el
historial y en el diario: "Actualicé los márgenes de mantenimiento y las comisiones con los de
tu cuenta de Binance."). En Ajustes › Riesgo (avanzado) se ve de dónde salen. Si los cambiás a
mano, la actualización diaria vuelve a poner los de tu cuenta. Si Binance rechaza la clave
(inválida, sin permiso de lectura o sin cuenta de futuros), el bot lo avisa en los errores
recientes, sigue con los supuestos y vuelve a probar al día siguiente o al reiniciar. El secret
nunca se escribe en los logs.

## Plata real (opcional, apagada por defecto)

Además de la simulación, el bot puede operar una sesión con plata real en futuros USDT-M de
Binance, en el mismo proceso. Las dos sesiones conviven: si la real falla o se apaga, la
simulación sigue igual. Diseño en `docs/superpowers/specs/2026-11-01-sereno-real-trading-design.md`.

Está apagada salvo que se cumplan **todas** estas condiciones:

- `SERENO_REAL_TRADING=on` en el `.env` (exactamente `on`).
- `BINANCE_TRADE_API_KEY` y `BINANCE_TRADE_API_SECRET`: una clave **aparte** de la de sólo lectura.
- `BINANCE_ENV`: `testnet` por defecto; `mainnet` sólo si lo ponés a mano.
- Pasan los chequeos de arranque (Ajustes › Plata real los muestra): la clave sin permiso de
  retiro y restringida por IP, modo de una posición por moneda, multi-activos y pago de
  comisiones con BNB apagados, saldo de futuros ≥ lo asignado, reloj a menos de 1 s de Binance.
  Si alguno falla, la sesión sólo puede cerrar o achicar, nunca abrir.
- Una sesión real creada en Ajustes › Plata real escribiendo el monto.

Cómo opera: margen aislado; stop y take profit cargados en Binance (`reduceOnly`, por la
cantidad exacta del bot, precio de marca); cada orden lleva el prefijo `sereno-<sesión>-` y el
bot nunca toca lo que abriste vos a mano en la misma moneda. Cada minuto compara lo que cree
tener con lo que dice Binance. El **tope de pérdida** (50 % por defecto) cierra todo y deja la
sesión apagada; para volver hay que crear otra.

Apagar: "Cerrar todo y apagar" en Ajustes › Plata real, o, si el bot no responde,

```sh
pnpm bot real-off      # cierra lo del bot a mercado, cancela sus stops y apaga la sesión
```

Primero probala en la testnet (`BINANCE_ENV` vacío o `testnet`, con una clave de la testnet
de futuros de Binance). Las direcciones de la testnet están en `REAL_HOSTS.testnet`
(`apps/bot/src/config.ts`); la documentación de Binance se contradice, así que la primera
corrida las confirma: si alguna está mal, los chequeos fallan y no opera.

## Deploy (para más adelante)

Hoy todo corre local. Cuando haya que publicar el dashboard:

1. **Base en Neon.** Siguiendo la convención Marrona (skill `marrona-neon-db`): una base
   `sereno` y un rol `sereno_app` en el proyecto compartido, con el revoke de
   `neon_superuser` aplicado y verificado. Salen dos URLs: `DATABASE_URL` (pooled, para el
   dashboard) y `DATABASE_URL_UNPOOLED` (directa, para migraciones y para el bot). Migrar con
   `DATABASE_URL_UNPOOLED=… pnpm db:migrate`.
2. **Dashboard en Vercel.** Proyecto con raíz `apps/web` y las variables de
   `apps/web/.env.example` en Production: `DATABASE_URL`, `BETTER_AUTH_SECRET`,
   `BETTER_AUTH_URL` (la URL pública), `ALLOWED_EMAILS`, y las de Google si se usan. El
   usuario se crea una vez con `DATABASE_URL=<la de Neon> pnpm db:seed-user`.
3. **Google (opcional).** Cliente OAuth "Web" en Google Cloud con scopes `openid email
   profile`; URI de redirección `<BETTER_AUTH_URL>/api/auth/callback/google` (y
   `http://localhost:3000/api/auth/callback/google` para local). Con `GOOGLE_CLIENT_ID` y
   `GOOGLE_CLIENT_SECRET` cargadas aparece el botón; sin ellas no.
4. **Bot.** Nunca en Vercel: sigue en la Mac (o en un servidor con el Dockerfile de arriba)
   apuntando con `DATABASE_URL` a la URL directa de Neon.
