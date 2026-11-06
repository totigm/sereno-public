import { describe, expect, it, vi } from 'vitest'
import { NO_KEY_MESSAGE } from '../../src/jobs/account-tiers'
import type { AccountRest } from '../../src/jobs/account-tiers'
import { accountTiersHook } from '../../src/live/hooks'
import type { AccountHookContext } from '../../src/live/live-types'
import { createLogger } from '../../src/logger'
import { logSink } from '../helpers/log-sink'

function restWithoutKey(): AccountRest & { calls: number } {
  const rest = {
    calls: 0,
    hasKey: () => false,
    leverageBrackets: async () => {
      rest.calls++
      return []
    },
    commissionRate: async (symbol: string) => {
      rest.calls++
      return { symbol, takerFeeRate: 0.0005, makerFeeRate: 0.0002 }
    },
  }
  return rest
}

const ctx: AccountHookContext = {
  sessionId: 'ses_sin_clave',
  repos: {} as AccountHookContext['repos'],
  reportError: vi.fn(),
}

describe('accountTiersHook', () => {
  it('sin clave lo dice una sola vez en el log al arrancar y nunca llama a Binance', async () => {
    const sink = logSink()
    const rest = restWithoutKey()
    const hook = accountTiersHook({ rest, logger: createLogger({ destination: sink.stream }) })
    await hook(ctx)
    await hook(ctx)
    expect(sink.lines().map((l) => l.msg)).toEqual([NO_KEY_MESSAGE])
    expect(NO_KEY_MESSAGE).toBe('Sin clave de Binance: uso los supuestos de mmr y comisiones')
    expect(rest.calls).toBe(0)
    expect(ctx.reportError).not.toHaveBeenCalled()
  })

  it('con clave no anuncia nada al crearse', () => {
    const sink = logSink()
    accountTiersHook({ rest: { ...restWithoutKey(), hasKey: () => true }, logger: createLogger({ destination: sink.stream }) })
    expect(sink.lines()).toEqual([])
  })
})
