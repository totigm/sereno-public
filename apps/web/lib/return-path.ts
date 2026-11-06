export const ACCESS_PATH = '/acceso'

/** Parámetro de `/acceso` con la ruta a la que volver después de entrar. */
export const RETURN_PARAM = 'volver'

const HOME = '/'

// Destino después de entrar: sólo rutas internas del dashboard. `//x` y `/\x` los
// navegadores los leen como otro host; `/acceso` y `/api` no son destinos.
export function safeReturnPath(raw: string | string[] | undefined): string {
  if (typeof raw !== 'string') return HOME
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return HOME
  if (/^\/(acceso|api)(?=[/?#]|$)/.test(raw)) return HOME
  return raw
}
