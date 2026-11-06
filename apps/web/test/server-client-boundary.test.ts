// @vitest-environment node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// jsdom no respeta el borde de React Server Components: un componente del servidor que
// llama a una función exportada por un módulo 'use client' pasa todos los tests y rompe
// cada página en Next ("Attempted to call x() from the server"). Del lado del servidor,
// lo que sale de un módulo 'use client' es una referencia: sirve para dibujarla como
// componente, no para llamarla ni leerla. Este test recorre el grafo del servidor (desde
// app/ y proxy.ts, sin cruzar a módulos 'use client') y exige que de esos módulos sólo se
// importen tipos y componentes.
const WEB = fileURLToPath(new URL('..', import.meta.url))
const EXTENSIONS = ['.ts', '.tsx', '/index.ts', '/index.tsx']
const DIRECTIVE = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*['"]use client['"]/
const IMPORT = /^(import|export)\s+(type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gm
const COMPONENT = /^[A-Z]/

interface Import {
  typeOnly: boolean
  clause: string
  specifier: string
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry) ? [path] : []
  })
}

function resolveLocal(from: string, specifier: string): string | null {
  const base = specifier.startsWith('@/') ? join(WEB, specifier.slice(2)) : specifier.startsWith('.') ? resolve(dirname(from), specifier) : null
  if (base === null) return null
  const found = [base, ...EXTENSIONS.map((ext) => base + ext)].find((path) => existsSync(path) && statSync(path).isFile())
  return found ?? null
}

function importsOf(source: string): Import[] {
  return [...source.matchAll(IMPORT)].map((match) => ({ typeOnly: match[2] !== undefined, clause: match[3] ?? '', specifier: match[4] ?? '' }))
}

/** Los nombres con valor que trae una importación (sin los `type X` sueltos). */
function valueBindings(clause: string): string[] {
  const named = /\{([\s\S]*)\}/.exec(clause)
  const outside = clause.replace(/\{[\s\S]*\}/, '').split(',').map((part) => part.trim()).filter(Boolean)
  const inside = (named?.[1] ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '' && !part.startsWith('type '))
    .map((part) => part.split(/\s+as\s+/).pop() ?? part)
  return [...outside, ...inside].map((name) => name.replace(/^\*\s+as\s+/, '* as '))
}

function serverViolations(): string[] {
  const isClient = (path: string) => DIRECTIVE.test(readFileSync(path, 'utf8'))
  const pending = [...sources(join(WEB, 'app')), join(WEB, 'proxy.ts')].filter((path) => !isClient(path))
  const seen = new Set<string>()
  const violations: string[] = []
  while (pending.length > 0) {
    const file = pending.pop()
    if (file === undefined || seen.has(file)) continue
    seen.add(file)
    for (const { typeOnly, clause, specifier } of importsOf(readFileSync(file, 'utf8'))) {
      const target = resolveLocal(file, specifier)
      if (target === null) continue
      if (!isClient(target)) {
        pending.push(target)
        continue
      }
      if (typeOnly) continue
      for (const name of valueBindings(clause)) {
        if (!COMPONENT.test(name)) violations.push(`${relative(WEB, file)} importa ${name} de ${relative(WEB, target)}`)
      }
    }
  }
  return violations
}

describe('borde servidor / cliente', () => {
  it('lee los nombres con valor de una importación', () => {
    expect(valueBindings('{ SessionSwitch, showsSwitch, type SessionSwitcher }')).toEqual(['SessionSwitch', 'showsSwitch'])
    expect(valueBindings('Default, { a as B }')).toEqual(['Default', 'B'])
    expect(valueBindings('* as all')).toEqual(['* as all'])
  })

  it('el servidor sólo toma tipos y componentes de los módulos use client', () => {
    expect(serverViolations()).toEqual([])
  })
})
