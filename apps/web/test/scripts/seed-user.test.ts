// @vitest-environment node
import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { and, eq } from 'drizzle-orm'
import { verifyPassword } from 'better-auth/crypto'
import { account, session, user, verification, type DirectDb } from '@sereno/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAuth } from '../../lib/auth-config'
import { generatePassword } from '../../scripts/user/password'
import { seedUser } from '../../scripts/user/seed-user'
import { openTestDb, TEST_URL } from './db'

const EMAIL = 'seed-user-test@example.com'
const base = { email: EMAIL, secret: 'x'.repeat(32), baseURL: 'http://localhost:3099', allowedEmails: `${EMAIL},otro@example.com` }

describe.skipIf(TEST_URL === undefined)('seedUser (Postgres)', () => {
  let db: DirectDb

  const credential = async (userId: string) => {
    const [row] = await db.select().from(account).where(and(eq(account.userId, userId), eq(account.providerId, 'credential')))
    return row
  }

  beforeAll(async () => {
    db = await openTestDb()
    await db.delete(user).where(eq(user.email, EMAIL))
  })

  afterAll(async () => {
    await db?.delete(user).where(eq(user.email, EMAIL))
    await db?.$client.end()
  })

  it('crea el usuario con el email verificado y la contraseña dada', async () => {
    const password = generatePassword()
    const result = await seedUser({ ...base, db, password })
    expect(result.created).toBe(true)
    const [row] = await db.select().from(user).where(eq(user.email, EMAIL))
    expect(row?.emailVerified).toBe(true)
    const hash = (await credential(result.userId))?.password
    expect(hash).toBeTruthy()
    expect(await verifyPassword({ hash: hash ?? '', password })).toBe(true)
  })

  it('es idempotente: la segunda vez actualiza la contraseña y sigue verificado', async () => {
    const password = generatePassword()
    const result = await seedUser({ ...base, db, password })
    expect(result.created).toBe(false)
    const users = await db.select().from(user).where(eq(user.email, EMAIL))
    expect(users).toHaveLength(1)
    expect(users[0]?.emailVerified).toBe(true)
    expect(await verifyPassword({ hash: (await credential(result.userId))?.password ?? '', password })).toBe(true)
  })

  it('la contraseña sembrada entra con la configuración del dashboard', async () => {
    const password = generatePassword()
    await seedUser({ ...base, db, password })
    const dashboard = createAuth({ ...base, database: drizzleAdapter(db, { provider: 'pg', schema: { user, session, account, verification } }) })
    const result = await dashboard.api.signInEmail({ body: { email: EMAIL, password } })
    expect(result.user.email).toBe(EMAIL)
    await expect(dashboard.api.signInEmail({ body: { email: EMAIL, password: `${password}x` } })).rejects.toMatchObject({ status: 'UNAUTHORIZED' })
  })

  it('no crea a nadie fuera de la lista blanca', async () => {
    await expect(seedUser({ ...base, db, email: 'intruso@example.com', password: generatePassword() })).rejects.toThrow()
    expect(await db.select().from(user).where(eq(user.email, 'intruso@example.com'))).toHaveLength(0)
  })
})
