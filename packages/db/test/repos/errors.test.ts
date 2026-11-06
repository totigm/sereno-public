import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDirectDb, type DirectDb } from '../../src/client'
import { isDatabaseError } from '../../src/repos/errors'
import { openTestDb } from './helpers'

let db: DirectDb

beforeAll(async () => {
  db = await openTestDb()
})

afterAll(async () => {
  await db.$client.end()
})

describe('isDatabaseError', () => {
  it('reconoce una consulta que Postgres rechazó', async () => {
    const error = await db.execute(sql`select * from tabla_que_no_existe`).catch((e: unknown) => e)
    expect(isDatabaseError(error)).toBe(true)
  })

  it('reconoce una base a la que no se puede conectar', async () => {
    const down = createDirectDb('postgresql://postgres@127.0.0.1:1/nadie_test', { max: 1 })
    try {
      const error = await down.transaction(async (tx) => tx.execute(sql`select 1`)).catch((e: unknown) => e)
      expect(isDatabaseError(error)).toBe(true)
    } finally {
      await down.$client.end()
    }
  })

  it('no confunde otros errores, ni uno de red que no es de la base', () => {
    expect(isDatabaseError(new Error('replay: sin universo'))).toBe(false)
    expect(isDatabaseError('texto')).toBe(false)
    // Lo que deja `fetch` cuando Binance no responde: el código de red viene en la causa.
    const network = new Error('Binance: red caída en /fapi/v1/klines', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) })
    expect(isDatabaseError(network)).toBe(false)
  })
})
