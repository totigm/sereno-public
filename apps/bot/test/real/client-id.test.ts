import { describe, expect, it } from 'vitest'
import { ClientIds, parseClientId, sessionShort } from '../../src/real/client-id'

const SESSION = 'ses_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const NOW = Date.UTC(2026, 10, 1, 12)
// Lo que Binance acepta en `newClientOrderId` y `clientAlgoId` (verificado en el Task 5).
const BINANCE_CLIENT_ID = /^[.A-Z:/a-z0-9_-]{1,36}$/

describe('sessionShort', () => {
  it('toma los primeros 8 caracteres hex del uuid de la sesión', () => {
    expect(sessionShort(SESSION)).toBe('0a1b2c3d')
    expect(sessionShort('ses_ABCDEF01-4e5f-4a6b-8c7d-9e0f1a2b3c4d')).toBe('abcdef01')
  })

  it('rechaza lo que no es un id de sesión', () => {
    expect(() => sessionShort('0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d')).toThrow(/sesión/)
    expect(() => sessionShort('ses_xyz')).toThrow(/sesión/)
  })
})

describe('ClientIds', () => {
  it('ida y vuelta: parseClientId reconoce la sesión y el tipo', () => {
    const ids = new ClientIds(SESSION, () => NOW)
    for (const kind of ['o', 'c', 's', 't', 'x'] as const) {
      const id = ids.next(kind)
      expect(id.startsWith('sereno-0a1b2c3d-')).toBe(true)
      expect(parseClientId(id)).toEqual({ short: '0a1b2c3d', kind })
    }
    expect(ids.short).toBe('0a1b2c3d')
  })

  it('dos next seguidos en el mismo milisegundo son distintos', () => {
    const ids = new ClientIds(SESSION, () => NOW)
    const a = ids.next('s')
    const b = ids.next('s')
    expect(a).not.toBe(b)
    expect(a).toBe(`sereno-0a1b2c3d-s${NOW.toString(36)}0`)
    expect(b).toBe(`sereno-0a1b2c3d-s${NOW.toString(36)}1`)
  })

  it('el largo no pasa de 36 y cumple el formato de Binance', () => {
    let now = Date.UTC(2059, 0, 1)
    const ids = new ClientIds(SESSION, () => now)
    for (let i = 0; i < 2_000; i++) {
      now += 1
      const id = ids.next('x')
      expect(id.length).toBeLessThanOrEqual(36)
      expect(id).toMatch(BINANCE_CLIENT_ID)
    }
  })
})

describe('parseClientId', () => {
  it('lo que no es del bot devuelve null', () => {
    expect(parseClientId('autoclose-123')).toBeNull()
    expect(parseClientId('adl_autoclose')).toBeNull()
    expect(parseClientId('web_12')).toBeNull()
    expect(parseClientId('algo_7')).toBeNull()
  })

  it('un id con forma de otra sesión no es de esta', () => {
    expect(parseClientId('sereno-otraaaaa-s1')).toBeNull()
    expect(parseClientId('sereno-ffffffff-s1')).toEqual({ short: 'ffffffff', kind: 's' })
    expect(parseClientId('sereno-ffffffff-s1')!.short).not.toBe(sessionShort(SESSION))
  })

  it('rechaza un tipo desconocido o sin sufijo', () => {
    expect(parseClientId('sereno-0a1b2c3d-z1')).toBeNull()
    expect(parseClientId('sereno-0a1b2c3d-s')).toBeNull()
    expect(parseClientId('sereno-0a1b2c3d-s1-extra')).toBeNull()
  })
})
