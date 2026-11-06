// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

// `env` valida al importarse, y sólo del lado del servidor (sin `window`).
const VALID = {
  DATABASE_URL: 'postgresql://postgres@127.0.0.1:5499/sereno',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  BETTER_AUTH_URL: 'http://localhost:3000',
  ALLOWED_EMAILS: 'toti@example.com',
}

let consoleError: MockInstance<typeof console.error>

beforeEach(() => {
  vi.resetModules()
  for (const [key, value] of Object.entries(VALID)) vi.stubEnv(key, value)
  // El validador vuelca los problemas por consola antes de lanzar.
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function loadEnv(google: { id?: string; secret?: string }) {
  vi.stubEnv('GOOGLE_CLIENT_ID', google.id)
  vi.stubEnv('GOOGLE_CLIENT_SECRET', google.secret)
  return (await import('@/lib/env')).env
}

const PAIR_MESSAGE = 'GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET van juntos: completá los dos para entrar con Google, o ninguno.'

describe('env: credenciales de Google', () => {
  it('con las dos, Google queda configurado', async () => {
    const env = await loadEnv({ id: 'cliente.apps.googleusercontent.com', secret: 'GOCSPX-secreto' })
    expect(env.GOOGLE_CLIENT_ID).toBe('cliente.apps.googleusercontent.com')
    expect(env.GOOGLE_CLIENT_SECRET).toBe('GOCSPX-secreto')
  })

  it('sin ninguna (o vacías en el .env), arranca sin Google', async () => {
    expect((await loadEnv({})).GOOGLE_CLIENT_ID).toBeUndefined()
    vi.resetModules()
    expect((await loadEnv({ id: '', secret: '' })).GOOGLE_CLIENT_SECRET).toBeUndefined()
  })

  it.each([
    { falta: 'GOOGLE_CLIENT_SECRET', google: { id: 'cliente.apps.googleusercontent.com' } },
    { falta: 'GOOGLE_CLIENT_ID', google: { secret: 'GOCSPX-secreto', id: '' } },
  ])('con una sola no arranca y avisa por $falta', async ({ falta, google }) => {
    await expect(loadEnv(google)).rejects.toThrow('Invalid environment variables')
    const issues = consoleError.mock.calls.flatMap((args) => args.slice(1)).flat() as { message: string; path?: PropertyKey[] }[]
    expect(issues).toContainEqual(expect.objectContaining({ message: PAIR_MESSAGE, path: [falta] }))
  })
})
