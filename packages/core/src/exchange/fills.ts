import type { OrderSide } from './types'

export interface FillPriceInput {
  lastPrice: number
  halfSpreadRate: number
  slippageRate: number
  // Nocional al último precio (qty × last), base del slippage por tamaño y de los costos.
  notional: number
  side: OrderSide
  // Slippage adicional en contra, como fracción. Las órdenes de stop/TP pasan un
  // slippage más, así el total queda en medio spread + 2 × slippage (spec §6).
  adverseExtra?: number
}

export interface FillPriceResult {
  price: number
  spreadCost: number
  slippageCost: number
}

export const SLIPPAGE_NOTIONAL_STEP = 10_000
export const SLIPPAGE_PER_STEP = 0.0001

// Slippage efectivo: la base más 0,01% por cada 10.000 USDT completos de nocional.
export function slippageForNotional(baseRate: number, notional: number): number {
  return baseRate + SLIPPAGE_PER_STEP * Math.floor(notional / SLIPPAGE_NOTIONAL_STEP)
}

// Fill de una orden a mercado: último precio ± medio spread ± slippage, siempre en contra.
export function fillPrice(input: FillPriceInput): FillPriceResult {
  const slippage = slippageForNotional(input.slippageRate, input.notional) + (input.adverseExtra ?? 0)
  const direction = input.side === 'buy' ? 1 : -1
  return {
    price: input.lastPrice * (1 + direction * (input.halfSpreadRate + slippage)),
    spreadCost: input.notional * input.halfSpreadRate,
    slippageCost: input.notional * slippage,
  }
}
