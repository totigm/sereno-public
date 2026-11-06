import { formatUsdRound } from '@sereno/core/src/journal/format'
import { coinName } from '@sereno/core/src/journal/coin-name'
import type { UniverseOutReason, UniverseOutView } from '@/lib/queries/ajustes'

// Por qué una moneda queda fuera del tablero (spec §5.1 y §11.1 Ajustes › Universo), en
// una frase corta que sigue al nombre: "ETH: el mínimo de Binance es US$ 20, …".

const REASONS: Record<Exclude<UniverseOutReason, 'below_min_notional'>, string> = {
  contract_type: 'no es un contrato perpetuo',
  status: 'Binance no la tiene operando',
  quote_asset: 'no cotiza en USDT',
  underlying_type: 'no es una moneda',
  tradfi: 'es TradFi y no está incluido',
  stablecoin: 'es una stablecoin',
  history: 'tiene menos historia que la pedida',
  excluded: 'la excluiste vos',
  no_volume: 'no tiene volumen de las últimas 24 h',
  no_contract: 'no tiene contrato en Binance',
}

function reasonText({ reason, detail }: UniverseOutView): string {
  if (reason !== 'below_min_notional') return REASONS[reason]
  const min = detail === undefined ? Number.NaN : Number(detail)
  return Number.isFinite(min)
    ? `el mínimo de Binance es ${formatUsdRound(min)}, más de lo que permite tu capital`
    : 'el mínimo de Binance es más de lo que permite tu capital'
}

export function universeOutPhrase(symbol: string, out: UniverseOutView): string {
  const why = reasonText(out)
  return `${coinName(symbol)}: ${out.pinned ? `fijada, pero ${why}` : why}.`
}
