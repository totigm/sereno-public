import { createDbFromUrl, createRepos, type Db, type Repos } from '@sereno/db'
import { env } from './env'

// Una sola pool por proceso. En `next dev` el HMR vuelve a evaluar los módulos y sin
// esto cada recarga abriría una pool nueva contra Postgres. En producción la URL es la
// pooled de Neon (neon-serverless); en desarrollo, Postgres local (node-postgres).
const globalForDb = globalThis as typeof globalThis & { serenoDb?: Db }

export const db: Db = globalForDb.serenoDb ?? createDbFromUrl(env.DATABASE_URL)

if (process.env.NODE_ENV !== 'production') globalForDb.serenoDb = db

/** Los repositorios de `@sereno/db` sobre la pool del dashboard. */
export const repos: Repos = createRepos(db)
