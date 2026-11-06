import { z } from 'zod'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { newCommandId } from '@/components/posiciones/command-id'

// El id del comando lo genera el navegador (clave de idempotencia de la cola) y el
// servidor lo valida con `z.uuid()`.

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('id de un comando', () => {
  it('en contexto seguro usa `crypto.randomUUID`', () => {
    vi.stubGlobal('crypto', { randomUUID: () => '0f8d2c1e-5b7a-4c3d-9e6f-1a2b3c4d5e6f', getRandomValues: () => { throw new Error('no se usa') } })
    expect(newCommandId()).toBe('0f8d2c1e-5b7a-4c3d-9e6f-1a2b3c4d5e6f')
  })

  it('sin contexto seguro (http en la red local) arma un UUID v4 válido con `getRandomValues`', () => {
    const real = globalThis.crypto
    vi.stubGlobal('crypto', { getRandomValues: <T extends ArrayBufferView>(bytes: T) => real.getRandomValues(bytes) })
    const ids = [newCommandId(), newCommandId()]
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      expect(z.uuid().safeParse(id).success).toBe(true)
    }
    expect(ids[0]).not.toBe(ids[1])
  })
})
