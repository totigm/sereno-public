# syntax=docker/dockerfile:1
# Imagen del bot para el worker futuro (spec §12 y §13). Hoy el bot corre en la Mac con
# `pnpm bot`, que es el supervisor `apps/bot/bin/sereno-bot.sh`: lo relanza si se cae y
# la mantiene despierta con `caffeinate -i -s`. Esto queda listo para un host que pase el
# gate de Binance (`curl https://fapi.binance.com/fapi/v1/ping` tiene que devolver 200
# desde esa IP); ahí no hay supervisor ni caffeinate: reinicia el orquestador.
#
# Se construye desde la raíz del monorepo (el contexto necesita el lockfile y los paquetes):
#   docker build -f apps/bot/Dockerfile -t sereno-bot .
#   docker run --env-file .env sereno-bot
# Variables: DATABASE_URL_UNPOOLED y LOG_LEVEL; opcionales BINANCE_API_KEY y BINANCE_API_SECRET.

ARG NODE_IMAGE=node:22-slim

# --- Dependencias: sólo las de producción del bot y sus paquetes internos ---
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
# Corepack toma la versión exacta de pnpm del campo `packageManager` del package.json raíz.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
# Todos los package.json del workspace: el lockfile los nombra a todos y `--frozen-lockfile`
# exige que coincidan; el filtro decide qué se instala.
COPY apps/bot/package.json apps/bot/
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --prod --filter "@sereno/bot..."

# --- Imagen final: node, los módulos instalados y el código fuente (tsx lo corre sin build) ---
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    TZ=UTC
WORKDIR /app
COPY --from=deps /app ./
COPY tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json packages/shared/
COPY packages/shared/src packages/shared/src
COPY packages/core/package.json packages/core/tsconfig.json packages/core/
COPY packages/core/src packages/core/src
COPY packages/db/package.json packages/db/tsconfig.json packages/db/
COPY packages/db/src packages/db/src
COPY apps/bot/package.json apps/bot/tsconfig.json apps/bot/
COPY apps/bot/src apps/bot/src
# Los archivos quedan de root y de sólo lectura para el proceso: corre como `node`.
USER node
WORKDIR /app/apps/bot
# Un solo proceso (sin pnpm ni el CLI de tsx en el medio): `docker stop` le manda SIGTERM
# directo al bot, que guarda lo pendiente y suelta el lease. Docker relanza según la
# política de reinicio del contenedor (`--restart unless-stopped`).
CMD ["node", "--import", "tsx", "src/index.ts", "live"]
