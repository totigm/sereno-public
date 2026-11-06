// @vitest-environment node
import { memoryAdapter, type MemoryDB } from 'better-auth/adapters/memory'
import { hashPassword } from 'better-auth/crypto'
import { describe, expect, it } from 'vitest'
import { isAllowed, NOT_ALLOWED } from '@/lib/allowlist'
import { createAuth } from '@/lib/auth-config'
import { allowlistGuards } from '@/lib/auth-guards'

const OWNER = 'owner@example.com'
const PASSWORD = 'una-contraseña-larga'
const SECRET = 'secreto-de-prueba-de-al-menos-32-caracteres'

function userRow(email: string) {
  const now = new Date()
  return { id: 'u1', name: 'Toti', email, emailVerified: true, image: null, createdAt: now, updatedAt: now }
}

describe('isAllowed', () => {
  it('compara sin distinguir mayúsculas', () => {
    expect(isAllowed('Owner@Example.com', 'owner@example.com')).toBe(true)
  })

  it('rechaza un email que no está en la lista', () => {
    expect(isAllowed('otra@gmail.com', 'owner@example.com')).toBe(false)
  })

  it('lee una lista separada por comas, con espacios y mayúsculas', () => {
    const list = ' alguien@ejemplo.com , Owner@Example.com ,'
    expect(isAllowed(OWNER, list)).toBe(true)
    expect(isAllowed('alguien@ejemplo.com', list)).toBe(true)
    expect(isAllowed('nadie@ejemplo.com', list)).toBe(false)
  })

  it('no confunde un email con otro que lo contiene', () => {
    expect(isAllowed('example.com', OWNER)).toBe(false)
    expect(isAllowed('xowner@example.com', OWNER)).toBe(false)
  })

  it('una lista vacía no deja pasar a nadie, ni a un email vacío', () => {
    expect(isAllowed(OWNER, '')).toBe(false)
    expect(isAllowed('', '')).toBe(false)
    expect(isAllowed('', ' , ')).toBe(false)
  })

  it('sin email no hay acceso', () => {
    expect(isAllowed(null, OWNER)).toBe(false)
    expect(isAllowed(undefined, OWNER)).toBe(false)
  })
})

describe('allowlistGuards', () => {
  const guards = allowlistGuards(OWNER)

  it('user.create.before lanza para un email no permitido', async () => {
    await expect(guards.beforeUserCreate(userRow('otra@gmail.com'))).rejects.toMatchObject({
      status: 'FORBIDDEN',
      body: { code: NOT_ALLOWED },
    })
  })

  it('user.create.before deja crear la cuenta permitida', async () => {
    await expect(guards.beforeUserCreate(userRow('Owner@Example.com'))).resolves.toBeUndefined()
  })

  it('validateUserInfo rechaza un perfil de Google fuera de la lista en cada inicio de sesión', () => {
    const result = guards.validateUserInfo({
      user: { email: 'otra@gmail.com' },
      source: { action: 'sign-in', method: 'oauth', oauth: { providerId: 'google' } },
    })
    expect(result).toMatchObject({ error: NOT_ALLOWED })
  })

  it('validateUserInfo deja pasar el perfil permitido', () => {
    const result = guards.validateUserInfo({
      user: { email: OWNER },
      source: { action: 'sign-in', method: 'oauth', oauth: { providerId: 'google' } },
    })
    expect(result).toBeUndefined()
  })
})

describe('createAuth', () => {
  async function setup(allowedEmails: string) {
    const now = new Date()
    const db: MemoryDB = {
      user: [userRow(OWNER)],
      account: [
        {
          id: 'a1',
          accountId: 'u1',
          providerId: 'credential',
          userId: 'u1',
          password: await hashPassword(PASSWORD),
          createdAt: now,
          updatedAt: now,
        },
      ],
      session: [],
      verification: [],
    }
    const auth = createAuth({
      database: memoryAdapter(db),
      secret: SECRET,
      baseURL: 'http://localhost:3000',
      allowedEmails,
    })
    return { db, auth }
  }

  it('entra con contraseña la cuenta de la lista', async () => {
    const { db, auth } = await setup(OWNER)
    const result = await auth.api.signInEmail({ body: { email: OWNER, password: PASSWORD } })
    expect(result.user.email).toBe(OWNER)
    expect(db.session).toHaveLength(1)
  })

  it('no abre sesión si el email salió de la lista, aunque la contraseña sea correcta', async () => {
    const { db, auth } = await setup('otra@gmail.com')
    await expect(auth.api.signInEmail({ body: { email: OWNER, password: PASSWORD } })).rejects.toMatchObject({
      status: 'FORBIDDEN',
      body: { code: NOT_ALLOWED },
    })
    expect(db.session).toHaveLength(0)
  })

  it('no tiene alta pública con email y contraseña', async () => {
    const { db, auth } = await setup(OWNER)
    await expect(
      auth.api.signUpEmail({ body: { email: 'otra@gmail.com', password: PASSWORD, name: 'Otra' } }),
    ).rejects.toMatchObject({ status: 'BAD_REQUEST' })
    expect(db.user).toHaveLength(1)
  })

  it('sólo configura Google cuando hay credenciales', async () => {
    const { auth: without } = await setup(OWNER)
    expect(without.options.socialProviders).toBeUndefined()

    const withGoogle = createAuth({
      database: memoryAdapter({ user: [], account: [], session: [], verification: [] }),
      secret: SECRET,
      baseURL: 'http://localhost:3000',
      allowedEmails: OWNER,
      google: { clientId: 'id', clientSecret: 'secret' },
    })
    expect(withGoogle.options.socialProviders?.google).toMatchObject({ clientId: 'id' })
  })
})
