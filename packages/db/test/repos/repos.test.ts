import { Pool as NeonPool } from '@neondatabase/serverless'
import { Pool as PgPool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@sereno/shared'
import { createDbFromUrl, type DirectDb } from '../../src/client'
import { createRepos } from '../../src/repos'
import { sessions } from '../../src/schema'
import { position } from './fixtures'
import { openTestDb, TEST_URL, truncate } from './helpers'

let db: DirectDb

beforeAll(async () => {
  db = await openTestDb()
})

afterAll(async () => {
  await db.$client.end()
})

beforeEach(async () => {
  await truncate(db, sessions)
})

describe('createDbFromUrl', () => {
  it('usa node-postgres para un Postgres local y lee de verdad', async () => {
    const local = createDbFromUrl(TEST_URL, { max: 1 })
    try {
      expect(local.$client).toBeInstanceOf(PgPool)
      expect(await createRepos(local).sessions.listAll()).toEqual([])
    } finally {
      await local.$client.end()
    }
  })

  it('usa el driver serverless de Neon para un host *.neon.tech', async () => {
    const neon = createDbFromUrl('postgresql://u:p@ep-quiet-cell-a1b2c3-pooler.us-east-2.aws.neon.tech/sereno?sslmode=require')
    expect(neon.$client).toBeInstanceOf(NeonPool)
    // El pool no conecta hasta la primera consulta.
    await neon.$client.end()
  })
})

describe('createRepos', () => {
  it('dentro de una transacción, un error deshace todo lo escrito con los repos', async () => {
    await expect(
      db.transaction(async (tx) => {
        const repos = createRepos(tx)
        const s = await repos.sessions.createLive({ capitalInicial: 1000, settings: DEFAULT_SETTINGS, learningOrigin: 'zero' })
        await repos.positions.upsertOpen(s.id, position('sol'))
        throw new Error('se cayó a mitad de camino')
      }),
    ).rejects.toThrow('se cayó a mitad de camino')
    expect(await createRepos(db).sessions.listAll()).toEqual([])
  })
})
