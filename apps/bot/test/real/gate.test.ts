import { describe, expect, it } from 'vitest'
import { REAL_CHECK_IDS, type RealCheck, type RealCheckId, type RealGate } from '@sereno/shared'
import { decideGate, REAL_CHECK_MISSING, type GateInput } from '../../src/real/gate'

const allOk: RealCheck[] = REAL_CHECK_IDS.map((id) => ({ id, status: 'ok', detail: '' }))
const failing = (...ids: RealCheckId[]): RealCheck[] => allOk.map((c) => (ids.includes(c.id) ? { ...c, status: 'fail' } : c))

const READY: GateInput = {
  enabled: true,
  keysPresent: true,
  env: 'mainnet',
  checks: allOk,
  session: { realStatus: 'on', binanceEnv: 'mainnet' },
}

describe('decideGate', () => {
  it('lo que falta se lee después de "Apagada: falta"', () => {
    for (const id of REAL_CHECK_IDS) expect(REAL_CHECK_MISSING[id]).toMatch(/^(la|el|los|las) /)
  })

  it.each<[string, Partial<GateInput>, RealGate]>([
    ['sin claves', { keysPresent: false }, { mode: 'unguarded', missing: ['las claves de operación'] }],
    ['sesión de testnet con el bot en mainnet', { session: { realStatus: 'on', binanceEnv: 'testnet' } }, { mode: 'unguarded', missing: ['el entorno: la sesión es de testnet'] }],
    ['sesión de mainnet con el bot en testnet', { env: 'testnet' }, { mode: 'unguarded', missing: ['el entorno: la sesión es de real'] }],
    ['sin SERENO_REAL_TRADING=on', { enabled: false }, { mode: 'reduce_only', missing: ['SERENO_REAL_TRADING=on'] }],
    ['apagada en Ajustes', { session: { realStatus: 'off', binanceEnv: 'mainnet' } }, { mode: 'reduce_only', missing: ['prenderla en Ajustes'] }],
    ['apagada por el tope', { session: { realStatus: 'loss_floor', binanceEnv: 'mainnet' } }, { mode: 'reduce_only', missing: ['una sesión nueva (tocó el tope de pérdida)'] }],
    ['chequeos en rojo', { checks: failing('one_way', 'clock') }, { mode: 'reduce_only', missing: ['la cuenta en modo de una posición por moneda', 'la hora de la Mac igual a la de Binance'] }],
    ['todo en orden', {}, { mode: 'trading', missing: [] }],
  ])('%s', (_name, patch, expected) => {
    expect(decideGate({ ...READY, ...patch })).toEqual(expected)
  })

  it('sin la variable pero con claves: reduce_only, nunca unguarded', () => {
    expect(decideGate({ ...READY, enabled: false, checks: failing('wallet') })).toEqual({ mode: 'reduce_only', missing: ['SERENO_REAL_TRADING=on'] })
    expect(decideGate({ ...READY, enabled: false, checks: [] }).mode).toBe('reduce_only')
    expect(decideGate({ ...READY, enabled: false, session: { realStatus: 'loss_floor', binanceEnv: 'mainnet' } }).mode).toBe('reduce_only')
  })

  it('las reglas van en orden: la primera que falta manda', () => {
    expect(decideGate({ ...READY, keysPresent: false, enabled: false, env: 'testnet' }).missing).toEqual(['las claves de operación'])
    expect(decideGate({ ...READY, env: 'testnet', enabled: false }).missing).toEqual(['el entorno: la sesión es de real'])
    expect(decideGate({ ...READY, enabled: false, session: { realStatus: 'off', binanceEnv: 'mainnet' } }).missing).toEqual(['SERENO_REAL_TRADING=on'])
    expect(decideGate({ ...READY, checks: failing('wallet'), session: { realStatus: 'off', binanceEnv: 'mainnet' } }).missing).toEqual(['prenderla en Ajustes'])
  })

  it('un chequeo salteado no frena; uno que no corrió, sí', () => {
    const skipped = allOk.map((c) => (c.id === 'fee_burn_off' ? { ...c, status: 'skipped' as const } : c))
    expect(decideGate({ ...READY, checks: skipped }).mode).toBe('trading')
    // Antes de la primera corrida no hay chequeos: nunca se opera a ciegas.
    expect(decideGate({ ...READY, checks: [] })).toEqual({ mode: 'reduce_only', missing: REAL_CHECK_IDS.map((id) => REAL_CHECK_MISSING[id]) })
    expect(decideGate({ ...READY, checks: allOk.filter((c) => c.id !== 'wallet') })).toEqual({ mode: 'reduce_only', missing: ['el capital asignado en la billetera de futuros'] })
  })
})
