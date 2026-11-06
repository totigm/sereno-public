// @vitest-environment node
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseArgs } from '../../scripts/lib/args'
import { assertDevDatabase, assertNotProduction, databaseName, redactUrl } from '../../scripts/lib/db-url'
import { envValue, readEnvFile, upsertEnvValue, writeEnvValue } from '../../scripts/lib/env-file'
import { generatePassword } from '../../scripts/user/password'

describe('guarda de la base', () => {
  it('rechaza la base de la corrida real', () => {
    expect(() => assertDevDatabase('postgresql://postgres@127.0.0.1:5499/sereno')).toThrow(/"sereno"/)
  })

  it('rechaza cualquier base que no termine en _dev o _test', () => {
    expect(() => assertDevDatabase('postgresql://postgres@127.0.0.1:5499/sereno_prod')).toThrow(/_dev o _test/)
    expect(() => assertDevDatabase('postgresql://postgres@127.0.0.1:5499/dev_sereno')).toThrow()
  })

  it('acepta las de desarrollo y de prueba', () => {
    expect(() => assertDevDatabase('postgresql://postgres@127.0.0.1:5499/sereno_h_dev')).not.toThrow()
    expect(() => assertDevDatabase('postgresql://postgres@127.0.0.1:5499/sereno_h_test')).not.toThrow()
  })

  it('nunca escribe en Neon, aunque el nombre parezca de desarrollo', () => {
    const neon = 'postgresql://u:p@ep-x-123.us-east-2.aws.neon.tech/sereno_dev?sslmode=require'
    expect(() => assertDevDatabase(neon)).toThrow(/Neon/)
    expect(() => assertNotProduction(neon)).toThrow(/Neon/)
  })

  it('lee el nombre y oculta la contraseña al mostrar la URL', () => {
    expect(databaseName('postgresql://postgres@127.0.0.1:5499/sereno_h_dev')).toBe('sereno_h_dev')
    expect(redactUrl('postgresql://u:secreta@localhost:5432/x_dev')).not.toContain('secreta')
  })
})

describe('parseArgs', () => {
  it('separa posicionales y opciones con espacio o con =', () => {
    expect(parseArgs(['/', '--port', '3099', '--out=/tmp/x', '--', '--scenario-label', 'activa'], ['port', 'out', 'scenario-label'])).toEqual({
      positional: ['/'],
      options: { port: '3099', out: '/tmp/x', 'scenario-label': 'activa' },
    })
  })

  it('rechaza opciones desconocidas y opciones sin valor', () => {
    expect(() => parseArgs(['--escenario', 'x'], ['scenario'])).toThrow(/desconocida/)
    expect(() => parseArgs(['--scenario'], ['scenario'])).toThrow(/Falta el valor/)
    expect(() => parseArgs(['--scenario', '--db', 'x'], ['scenario', 'db'])).toThrow(/Falta el valor/)
  })
})

describe('archivo .env', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('agrega una variable nueva sin tocar el resto', () => {
    expect(upsertEnvValue('# comentario\nA=1', 'B', 'dos')).toBe('# comentario\nA=1\nB=dos\n')
  })

  it('reemplaza una variable existente en su lugar', () => {
    expect(upsertEnvValue('A=1\nB=viejo\nC=3\n', 'B', 'nuevo')).toBe('A=1\nB=nuevo\nC=3\n')
  })

  it('rechaza valores que habría que citar', () => {
    expect(() => upsertEnvValue('', 'A', 'con espacio')).toThrow()
    expect(() => upsertEnvValue('', 'a', 'x')).toThrow()
  })

  it('escribe con permisos sólo para el dueño y se puede volver a leer', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sereno-env-'))
    const path = join(dir, '.env.local')
    writeFileSync(path, 'DATABASE_URL=postgresql://x/y_dev\n')
    writeEnvValue(path, 'DASHBOARD_PASSWORD', 'abc_DEF-123')
    expect(readEnvFile(path)).toEqual({ DATABASE_URL: 'postgresql://x/y_dev', DASHBOARD_PASSWORD: 'abc_DEF-123' })
    expect(readFileSync(path, 'utf8')).toContain('DATABASE_URL=')
    expect(readEnvFile(join(dir, 'no-existe'))).toEqual({})
    const fresh = join(dir, 'nuevo.env')
    writeEnvValue(fresh, 'A', 'b')
    expect(statSync(fresh).mode & 0o777).toBe(0o600)
  })

  it('el entorno gana sobre el archivo y vacío cuenta como ausente', () => {
    vi.stubEnv('SERENO_PRUEBA', 'del-entorno')
    expect(envValue('SERENO_PRUEBA', { SERENO_PRUEBA: 'del-archivo' })).toBe('del-entorno')
    vi.stubEnv('SERENO_PRUEBA', '')
    expect(envValue('SERENO_PRUEBA', { SERENO_PRUEBA: 'del-archivo' })).toBe('del-archivo')
    expect(envValue('SERENO_PRUEBA', { SERENO_PRUEBA: '' })).toBeUndefined()
  })
})

describe('generatePassword', () => {
  it('genera contraseñas largas, sin caracteres a citar y distintas cada vez', () => {
    const a = generatePassword()
    const b = generatePassword()
    expect(a.length).toBeGreaterThanOrEqual(24)
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(a).not.toBe(b)
    expect(() => upsertEnvValue('', 'DASHBOARD_PASSWORD', a)).not.toThrow()
  })
})
