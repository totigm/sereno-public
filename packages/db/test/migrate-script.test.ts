import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

// `pnpm db:migrate` sin base: el migrador es un doble y `process.exit` corta el script.
const migrate = vi.hoisted(() => vi.fn<(url: string) => Promise<void>>())
vi.mock('@sereno/db/migrate', () => ({ migrate }))

class Exit extends Error {
  constructor(readonly code: number | string | null | undefined) {
    super(`process.exit(${code})`)
  }
}

let log: MockInstance<typeof console.log>
let error: MockInstance<typeof console.error>

beforeEach(() => {
  vi.resetModules()
  migrate.mockReset().mockResolvedValue(undefined)
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Exit(code)
  })
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
  error = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function runScript(url: string): Promise<unknown> {
  vi.stubEnv('DATABASE_URL_UNPOOLED', url)
  return import('../scripts/migrate').then(
    () => null,
    (err: unknown) => err,
  )
}

describe('scripts/migrate', () => {
  it('migra y muestra la URL sin la contraseña', async () => {
    expect(await runScript('postgresql://sereno:secreto@db.example.com:5432/sereno')).toBeNull()
    expect(migrate).toHaveBeenCalledWith('postgresql://sereno:secreto@db.example.com:5432/sereno')
    expect(log).toHaveBeenCalledWith('Migraciones aplicadas en postgresql://sereno@db.example.com:5432/sereno')
    expect(JSON.stringify(log.mock.calls)).not.toContain('secreto')
  })

  it('con una URL que no puede mostrar, sale antes de migrar', async () => {
    const err = await runScript('esto no es una url')
    expect(err).toBeInstanceOf(Exit)
    expect((err as Exit).code).toBe(1)
    expect(migrate).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith(expect.stringContaining('DATABASE_URL_UNPOOLED'))
  })
})
