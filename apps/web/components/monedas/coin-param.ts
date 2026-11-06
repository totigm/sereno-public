/** El parámetro de la URL con la moneda de la hoja abierta: `?moneda=SOLUSDT`. */
export const COIN_PARAM = 'moneda'

/** El valor de `?moneda=` que llega a la página, si vino uno solo. */
export function coinParam(searchParams: Record<string, string | string[] | undefined>): string | undefined {
  const value = searchParams[COIN_PARAM]
  return typeof value === 'string' && value !== '' ? value : undefined
}
