import { Pool as NeonPool } from '@neondatabase/serverless'
import { drizzle as drizzleNeon, type NeonDatabase } from 'drizzle-orm/neon-serverless'
import { drizzle as drizzleNode, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { Pool as PgPool } from 'pg'
import * as schema from './schema'

export type Schema = typeof schema

// El bot y las migraciones: `pg.Pool` sobre la URL directa (spec §10).
export type DirectDb = NodePgDatabase<Schema> & { $client: PgPool }
// El dashboard: WebSocket de Neon sobre la URL pooled.
export type PooledDb = NeonDatabase<Schema> & { $client: NeonPool }
// Lo que comparten ambos clientes; los repositorios se escriben contra este tipo.
export type Db = PgDatabase<PgQueryResultHKT, Schema>

// Las columnas se declaran en camelCase y van a SQL en snake_case; el mismo
// `casing` que `drizzle.config.ts`, si no las consultas y la migración no coinciden.
export const DB_CASING = 'snake_case' as const

export interface DbOptions {
  max?: number
}

export function createDirectDb(url: string, { max = 4 }: DbOptions = {}): DirectDb {
  const pool = new PgPool({ connectionString: url, max })
  return drizzleNode({ client: pool, schema, casing: DB_CASING })
}

export function createPooledDb(url: string, { max }: DbOptions = {}): PooledDb {
  // Sin `max`, el tope por defecto del pool de Neon.
  const pool = new NeonPool(max === undefined ? { connectionString: url } : { connectionString: url, max })
  return drizzleNeon({ client: pool, schema, casing: DB_CASING })
}

export type AnyDb = DirectDb | PooledDb

// El dashboard usa la misma URL en los dos mundos: Neon en producción (WebSocket
// por el pooler) y Postgres local en desarrollo, donde el driver de Neon no
// puede conectar. Se elige por el host para que nadie tenga que acordarse.
export function createDbFromUrl(url: string, opts: DbOptions = {}): AnyDb {
  return isNeonHost(url) ? createPooledDb(url, opts) : createDirectDb(url, opts)
}

function isNeonHost(url: string): boolean {
  return new URL(url).hostname.endsWith('.neon.tech')
}
