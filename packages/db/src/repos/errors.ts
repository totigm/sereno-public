// Errores de dominio que los repositorios traducen desde Postgres, para que el
// dashboard y el bot puedan decir qué pasó sin conocer códigos SQLSTATE.

import { DrizzleQueryError } from 'drizzle-orm'

// Hay una activa por tipo (`sessions_single_active_per_kind_idx`): la de papel y la
// de plata real conviven, pero no dos del mismo.
export class ActiveSessionExistsError extends Error {
  constructor(readonly kind: 'paper_live' | 'live' = 'paper_live') {
    super(
      kind === 'live'
        ? 'Ya hay una sesión con plata real activa: apagala y archivala antes de crear otra.'
        : 'Ya hay una simulación activa: archivala antes de crear otra.',
    )
    this.name = 'ActiveSessionExistsError'
  }
}

export class LearningSourceMissingError extends Error {
  constructor(origin: string) {
    super(`No encontré el aprendizaje de origen (${origin}) para la simulación nueva.`)
    this.name = 'LearningSourceMissingError'
  }
}

// Un ciclo del bot que todavía corre sobre una simulación ya archivada no le
// abre ni le cierra posiciones: la sesión archivada queda como la dejó el archivo.
export class SessionArchivedError extends Error {
  constructor(readonly sessionId: string) {
    super(`La simulación ${sessionId} está archivada: ya no se le escriben posiciones.`)
    this.name = 'SessionArchivedError'
  }
}

const UNIQUE_VIOLATION = '23505'

// Drizzle envuelve el error del driver (`DrizzleQueryError`) y lo deja en `cause`;
// pg y Neon traen el mismo `code` y `constraint`.
export function isUniqueViolation(err: unknown, constraint: string): boolean {
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    const { code, constraint: name } = e as Error & { code?: unknown; constraint?: unknown }
    if (code === UNIQUE_VIOLATION) return name === constraint
  }
  return false
}

const SQLSTATE = /^[0-9A-Z]{5}$/
const CONNECTION_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'EPIPE'])

// Un error de la base: una consulta que Postgres rechazó o que se cortó en el medio (Drizzle
// la envuelve en `DrizzleQueryError`; pg y Neon traen el SQLSTATE y la severidad), o una
// conexión que no se pudo abrir. Los códigos de red cuentan sólo arriba de todo: más abajo
// en la cadena de causas pueden ser de otro cliente (el `fetch` a Binance).
export function isDatabaseError(err: unknown): boolean {
  if (err instanceof Error && CONNECTION_CODES.has(String((err as Error & { code?: unknown }).code))) return true
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    if (e instanceof DrizzleQueryError) return true
    const { code, severity } = e as Error & { code?: unknown; severity?: unknown }
    if (typeof code === 'string' && SQLSTATE.test(code) && typeof severity === 'string') return true
  }
  return false
}
