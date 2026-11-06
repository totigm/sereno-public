import { sql, type SQL } from 'drizzle-orm'

// Campos calculados para las consultas que los repositorios de `@sereno/db` no
// traen. Los drivers devuelven `count(*)` (bigint) como texto y los timestamps de
// una expresión cruda sin decodificar: todo sale como número y los instantes en ms,
// igual que en el resto del motor. Un null de la base queda null (drizzle no
// decodifica nulls).

export function asNumber(expr: SQL): SQL<number> {
  return expr.mapWith(Number)
}

export function asNullableNumber(expr: SQL): SQL<number | null> {
  return expr.mapWith(Number) as SQL<number | null>
}

/**
 * Una subconsulta escalar entre paréntesis. Va anidada a propósito: en un `select`
 * de una sola tabla drizzle saca el nombre de tabla a las columnas del primer nivel
 * de cada campo, y en una subconsulta correlacionada `"id"` pasaría a ser el de la
 * tabla de adentro. Anidada, cada columna conserva su tabla.
 */
export function scalar<T = unknown>(query: SQL): SQL<T> {
  return sql<T>`(${query})`
}

/** Un `timestamptz` como ms desde la época. */
export function epochMs(expr: SQL): SQL<number | null> {
  return asNullableNumber(sql`round(extract(epoch from ${expr}) * 1000)`)
}

/** Un lapso en ms como `interval` (`millis` de `@sereno/db` no sale por su índice). */
export function interval(ms: number): SQL {
  if (!Number.isFinite(ms)) throw new RangeError(`Lapso no finito: ${ms} ms`)
  return sql`${Math.round(ms)}::double precision * interval '1 millisecond'`
}

/** Filas de un `db.execute` crudo: pg y Neon devuelven el mismo `{ rows }`. */
export function rowsOf<T>(result: unknown): T[] {
  return (result as { rows: T[] }).rows
}
