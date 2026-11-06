// Argumentos de línea de comandos al estilo `--clave valor` (o `--clave=valor`); lo
// que no lleva guiones es posicional. Sin dependencias: las herramientas piden poco.
export interface ParsedArgs {
  positional: string[]
  options: Record<string, string>
}

export function parseArgs(argv: readonly string[], known: readonly string[]): ParsedArgs {
  const positional: string[] = []
  const options: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    // pnpm reenvía el separador `--` cuando alguien lo escribe.
    if (arg === '--') continue
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const body = arg.slice(2)
    const eq = body.indexOf('=')
    const key = eq === -1 ? body : body.slice(0, eq)
    if (!known.includes(key)) {
      throw new Error(`Opción desconocida: --${key} (válidas: ${known.map((k) => `--${k}`).join(', ')})`)
    }
    const value = eq === -1 ? argv[++i] : body.slice(eq + 1)
    if (value === undefined || value === '' || value.startsWith('--')) throw new Error(`Falta el valor de --${key}`)
    options[key] = value
  }
  return { positional, options }
}
