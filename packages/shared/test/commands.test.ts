import { describe, it, expect } from 'vitest'
import { CommandSchema, COMMAND_TTL_MS, PRICE_SENSITIVE_COMMANDS, isPriceSensitive } from '../src/commands'

const base = {
  id: '6f1c2a9e-3b4d-4c5e-8f6a-7b8c9d0e1f2a',
  sessionId: 'ses_1',
  requestedBy: 'toti@example.com',
}

describe('CommandSchema', () => {
  it('acepta close_position con símbolo', () => {
    const cmd = CommandSchema.parse({ ...base, kind: 'close_position', payload: { symbol: 'SOLUSDT' } })
    expect(cmd.kind).toBe('close_position')
    if (cmd.kind === 'close_position') expect(cmd.payload.symbol).toBe('SOLUSDT')
  })
  it('acepta run_replay con sus parámetros', () => {
    const cmd = CommandSchema.parse({
      ...base,
      kind: 'run_replay',
      payload: { days: 90, capital: 1000, learningOrigin: 'zero', paramTuning: true },
    })
    expect(cmd.kind).toBe('run_replay')
  })
  it('acepta close_all sin payload y lo normaliza a {}', () => {
    const cmd = CommandSchema.parse({ ...base, kind: 'close_all' })
    expect(cmd.kind).toBe('close_all')
    expect(cmd.payload).toEqual({})
  })
  it('rechaza run_replay fuera de rango o con origen de aprendizaje inválido', () => {
    const payload = { days: 90, capital: 1000, learningOrigin: 'zero', paramTuning: true }
    expect(() => CommandSchema.parse({ ...base, kind: 'run_replay', payload: { ...payload, days: 0 } })).toThrow()
    expect(() => CommandSchema.parse({ ...base, kind: 'run_replay', payload: { ...payload, days: 366 } })).toThrow()
    expect(() => CommandSchema.parse({ ...base, kind: 'run_replay', payload: { ...payload, learningOrigin: 'continued' } })).toThrow()
  })
  it('cancel_replay exige replaySessionId', () => {
    expect(() => CommandSchema.parse({ ...base, kind: 'cancel_replay' })).toThrow()
    expect(() => CommandSchema.parse({ ...base, kind: 'cancel_replay', payload: {} })).toThrow()
    const cmd = CommandSchema.parse({ ...base, kind: 'cancel_replay', payload: { replaySessionId: 'ses_2' } })
    if (cmd.kind === 'cancel_replay') expect(cmd.payload.replaySessionId).toBe('ses_2')
  })
  it('rechaza close_position sin símbolo', () => {
    expect(() => CommandSchema.parse({ ...base, kind: 'close_position', payload: {} })).toThrow()
  })
  it('rechaza un kind desconocido, un id que no es uuid y un email inválido', () => {
    expect(() => CommandSchema.parse({ ...base, kind: 'explotar' })).toThrow()
    expect(() => CommandSchema.parse({ ...base, id: '123', kind: 'close_all' })).toThrow()
    expect(() => CommandSchema.parse({ ...base, requestedBy: 'toti', kind: 'close_all' })).toThrow()
  })
  it('los sensibles al precio vencen a los 60 s', () => {
    expect(PRICE_SENSITIVE_COMMANDS).toEqual(['close_position', 'close_all'])
    expect(COMMAND_TTL_MS).toBe(60_000)
    expect(isPriceSensitive('close_all')).toBe(true)
    expect(isPriceSensitive('run_replay')).toBe(false)
  })
  it('acepta real_off sin payload y nunca vence', () => {
    const cmd = CommandSchema.parse({ ...base, kind: 'real_off', payload: {} })
    expect(cmd.kind).toBe('real_off')
    expect(cmd.payload).toEqual({})
    expect(isPriceSensitive('real_off')).toBe(false)
  })
})
