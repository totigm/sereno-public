import { describe, expect, it } from 'vitest'
import { crossedBy } from '../../src/real/fired-trigger'

const stop = (triggerPrice: number) => ({ clientAlgoId: 'sereno-0a1b2c3d-s1', kind: 'stop' as const, triggerPrice })
const tp = (triggerPrice: number) => ({ clientAlgoId: 'sereno-0a1b2c3d-t1', kind: 'take_profit' as const, triggerPrice })

describe('crossedBy: cuándo Binance dispara un algo del bot con la marca', () => {
  it('en una larga, el stop en su precio o por debajo y el take profit en su precio o por encima', () => {
    expect([144, 145, 146].map((mark) => crossedBy(stop(145), 'long', mark))).toEqual([true, true, false])
    expect([159, 160, 161].map((mark) => crossedBy(tp(160), 'long', mark))).toEqual([false, true, true])
  })

  it('en una corta, al revés', () => {
    expect([154, 155, 156].map((mark) => crossedBy(stop(155), 'short', mark))).toEqual([false, true, true])
    expect([139, 140, 141].map((mark) => crossedBy(tp(140), 'short', mark))).toEqual([true, true, false])
  })
})
