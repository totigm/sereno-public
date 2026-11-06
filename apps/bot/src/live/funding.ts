// Funding en vivo (spec §6): el stream de marca trae la tasa `r` del período en curso y
// `T`, el próximo instante de liquidación. Cuando un tick muestra un `T` posterior al que
// se venía viendo, el período anterior se liquidó: se aplica con su última tasa conocida
// y la marca de ahora. Las que vencieron con el proceso caído las cobra la sesión al
// retomar, con el historial de REST (`funding-backfill.ts`).

import type { FundingEvent, MarkTick } from '@sereno/core'

export interface FundingState {
  rate: number | null
  nextFundingTime: number | null
}

export class FundingTracker {
  private readonly states = new Map<string, FundingState>()

  note(tick: MarkTick): FundingEvent | null {
    const prev = this.states.get(tick.symbol)
    this.states.set(tick.symbol, {
      rate: tick.fundingRate ?? prev?.rate ?? null,
      nextFundingTime: tick.nextFundingTime ?? prev?.nextFundingTime ?? null,
    })
    if (!prev || prev.rate === null || prev.nextFundingTime === null) return null
    if (tick.nextFundingTime === null || tick.nextFundingTime <= prev.nextFundingTime) return null
    return { symbol: tick.symbol, at: prev.nextFundingTime, rate: prev.rate, markPrice: tick.markPrice }
  }

  get(symbol: string): FundingState | undefined {
    return this.states.get(symbol)
  }
}
