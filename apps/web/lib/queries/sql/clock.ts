import { sql } from 'drizzle-orm'
import type { Db } from '@sereno/db'
import { asNumber } from './fields'

/** El reloj de la base, en ms: lo que el bot sella con `now()` se mide contra éste, no contra el del servidor web. */
export async function databaseNow(db: Db): Promise<number> {
  const [row] = await db.select({ now: asNumber(sql`round(extract(epoch from now()) * 1000)`) }).from(sql`(select 1) as clock`)
  if (!row) throw new Error('La base no devolvió la hora')
  return row.now
}
