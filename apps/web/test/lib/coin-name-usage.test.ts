// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Un solo nombre visible por moneda: la web usa `coinName` de core y no recorta símbolos
// por su cuenta (si no, el diario dice "1000PEPE" y el tablero "PEPE").
const WEB = fileURLToPath(new URL('../..', import.meta.url))
const LOCAL_TRIM = [/endsWith\(['"]USD[TC]['"]\)/, /\.replace\(\/[^/\n]*(?:USD[TC]|1000|1M)/, /\btileName\b/]

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry) ? [path] : []
  })
}

describe('nombres de moneda en la web', () => {
  it('ningún componente ni módulo de lib recorta el símbolo por su cuenta', () => {
    const offenders = ['components', 'lib']
      .flatMap((dir) => sources(join(WEB, dir)))
      .filter((path) => LOCAL_TRIM.some((pattern) => pattern.test(readFileSync(path, 'utf8'))))
      .map((path) => relative(WEB, path))
    expect(offenders).toEqual([])
  })
})
