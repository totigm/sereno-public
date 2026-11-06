import { CasingCache } from 'drizzle-orm/casing'
import { sql, type SQL } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { DB_CASING } from '../client'

const casing = new CasingCache(DB_CASING)

// `excluded.<columna>` para el `SET` de un `ON CONFLICT DO UPDATE`. Drizzle no
// lo trae: interpolar la columna daría el valor viejo de la fila, no el nuevo.
// El nombre sale del mismo `casing` que usan los clientes.
export function excluded(column: AnyPgColumn): SQL {
  return sql`excluded.${sql.identifier(casing.getColumnCasing(column))}`
}

// El instante de la base. Los sellos de "cuándo pasó" (claim, latido, lease,
// vencimiento, archivo) usan siempre este reloj, así se comparan contra el mismo
// `now()` que filtra en las consultas aunque el bot y Vercel tengan relojes distintos.
export const dbNow = sql<Date>`now()`

// El mismo `now()` leído como `Date`: dentro de una transacción es su instante de
// inicio, así lo que se escribe en distintas sentencias queda con el mismo sello.
// Una función y no una constante: `mapWith` modifica el `SQL` sobre el que se llama.
export function transactionNow(): SQL<Date> {
  return sql`now()`.mapWith((value: Date | string) => new Date(value))
}

// Un lapso en milisegundos como `interval` de Postgres, para sumarlo o restarlo a `now()`.
// `double precision` y no `integer`: un entero de 32 bits desborda pasados ~24,8
// días y la limpieza usa 30 y 90. Es exacto para enteros hasta 2^53.
export function millis(ms: number): SQL {
  if (!Number.isFinite(ms)) throw new RangeError(`Lapso no finito: ${ms} ms`)
  return sql`${Math.round(ms)}::double precision * interval '1 millisecond'`
}

// Postgres acepta hasta 65.535 parámetros por sentencia: los lotes grandes
// (velas, decisiones de un replay) se insertan de a pedazos.
export function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

// Los repos que escriben en lote aceptan una fila o varias.
export function asList<T>(items: T | readonly T[]): readonly T[] {
  return Array.isArray(items) ? (items as readonly T[]) : [items as T]
}

// Un `INSERT … ON CONFLICT DO UPDATE` no puede tocar dos veces la misma fila:
// de las repetidas en un lote queda la última, que es la más nueva.
export function lastBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...new Map(items.map((item) => [key(item), item])).values()]
}
