// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { versionToken, type LiveVersionRow } from '@/lib/queries/sql/live-version'

// Cada componente de la ficha, solo: si alguno no la cambiara, `/api/live` contestaría
// `{ unchanged: true }` con datos viejos.
const ROW: LiveVersionRow = {
  capitalInicial: 1000,
  startedAt: Date.parse('2026-10-14T13:00:00Z'),
  protegido: 0,
  baseBlindaje: 1000,
  market: 7,
  heartbeat: Date.parse('2026-10-31T17:32:00Z'),
  settings: 3,
  openHash: 'd41d8cd98f00b204e9800998ecf8427e',
  positions: 4,
  equityId: 120,
  commands: Date.parse('2026-10-31T17:32:20Z'),
  expiredCommands: 0,
  realStatus: null,
  now: Date.parse('2026-10-31T17:32:30Z'),
}
const DAY_START = Date.parse('2026-10-31T03:00:00Z')
const BASE = versionToken(ROW, false, DAY_START)

describe('versionToken', () => {
  it('con la misma fila da la misma ficha', () => {
    expect(versionToken({ ...ROW }, false, DAY_START)).toBe(BASE)
  })

  it('pasar a sin conexión cambia la ficha aunque la fila sea la misma', () => {
    expect(versionToken(ROW, true, DAY_START)).not.toBe(BASE)
  })

  it('un día nuevo en Buenos Aires cambia la ficha', () => {
    expect(versionToken(ROW, false, DAY_START + 86_400_000)).not.toBe(BASE)
  })

  it('un comando que venció por el reloj cambia la ficha', () => {
    expect(versionToken({ ...ROW, expiredCommands: 1 }, false, DAY_START)).not.toBe(BASE)
  })

  it('el blindaje cambia la ficha: protegido y base salen en el libro', () => {
    expect(versionToken({ ...ROW, protegido: 1000 }, false, DAY_START)).not.toBe(BASE)
    expect(versionToken({ ...ROW, baseBlindaje: 1250 }, false, DAY_START)).not.toBe(BASE)
  })

  it('apagar la sesión real (a mano o por el tope) cambia la ficha, aunque el bot no lata', () => {
    const on = versionToken({ ...ROW, realStatus: 'on' }, false, DAY_START)
    expect(on).not.toBe(BASE)
    expect(versionToken({ ...ROW, realStatus: 'loss_floor' }, false, DAY_START)).not.toBe(on)
    expect(versionToken({ ...ROW, realStatus: 'off' }, false, DAY_START)).not.toBe(on)
  })

  it('el reloj de la base solo no cambia la ficha', () => {
    expect(versionToken({ ...ROW, now: ROW.now + 5_000 }, false, DAY_START)).toBe(BASE)
  })
})
