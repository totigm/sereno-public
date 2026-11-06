import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DirectDb } from '../../src/client'
import { millis } from '../../src/repos/sql-helpers'
import { openTestDb } from './helpers'

const DAY_MS = 24 * 60 * 60 * 1000

let db: DirectDb

beforeAll(async () => {
  db = await openTestDb(1)
})

afterAll(async () => {
  await db.$client.end()
})

async function seconds(ms: number): Promise<number> {
  const result = await db.execute<{ s: string }>(sql`select extract(epoch from ${millis(ms)})::text as s`)
  return Number(result.rows[0]?.s)
}

describe('millis', () => {
  it('convierte lapsos cortos con fracción de segundo', async () => {
    expect(await seconds(1500)).toBe(1.5)
  })

  // La limpieza borra decisiones de más de 30 días y equity por minuto de más de
  // 90: con un cast a integer, cualquier lapso de más de ~24,8 días desbordaba.
  it('acepta lapsos de 30 y 90 días sin desbordar', async () => {
    expect(await seconds(30 * DAY_MS)).toBe(30 * 86400)
    expect(await seconds(90 * DAY_MS)).toBe(90 * 86400)
  })

  it('rechaza lapsos no finitos en vez de mandarlos a la base', () => {
    expect(() => millis(Number.POSITIVE_INFINITY)).toThrow(RangeError)
    expect(() => millis(Number.NaN)).toThrow(RangeError)
  })
})
