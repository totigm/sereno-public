// Las herramientas de desarrollo nunca escriben contra producción (Neon), y los
// datos de demostración tampoco contra la base de la corrida real (`sereno`).
const DEV_SUFFIXES = ['_dev', '_test'] as const

function parse(url: string): URL {
  try {
    return new URL(url)
  } catch {
    throw new Error('La URL de la base no es válida')
  }
}

export function databaseName(url: string): string {
  return decodeURIComponent(parse(url).pathname.replace(/^\//, ''))
}

export function isNeonUrl(url: string): boolean {
  return parse(url).hostname.endsWith('.neon.tech')
}

export function assertNotProduction(url: string): void {
  if (isNeonUrl(url)) throw new Error('Esta herramienta es de desarrollo: no la corras contra Neon (producción).')
}

export function assertDevDatabase(url: string): void {
  assertNotProduction(url)
  const name = databaseName(url)
  if (!DEV_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
    throw new Error(
      `No escribo datos de demostración en la base "${name}": sólo en bases cuyo nombre termine en _dev o _test. ` +
        'La base "sereno" es la de la corrida real y nunca se toca.',
    )
  }
}

// Para mostrar en consola sin la contraseña.
export function redactUrl(url: string): string {
  const parsed = parse(url)
  if (parsed.password !== '') parsed.password = '***'
  return parsed.toString()
}
