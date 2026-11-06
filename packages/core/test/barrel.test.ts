import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { EquityPoint as ShadowEquityPoint } from '../src/learning/shadow'
import * as core from '../src/index'
import { INTERNAL_FILES, INTERNAL_NAMES } from './barrel-internals'

const SRC = fileURLToPath(new URL('../src/', import.meta.url))
const BARREL = 'index.ts'

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.name.endsWith('.ts') ? [relative(SRC, path).split(sep).join('/')] : []
  })
}

async function exportsOf(file: string): Promise<Record<string, unknown>> {
  return (await import(pathToFileURL(join(SRC, file)).href)) as Record<string, unknown>
}

const barrel: Record<string, unknown> = core

// Un símbolo (o unos pocos) de cada módulo de core: si el barrel pierde un módulo entero,
// falla acá con un nombre que se entiende.
const REPRESENTATIVES: Record<string, string[]> = {
  tipos: ['SIGNAL_IDS'],
  indicadores: ['sma', 'ema', 'atr', 'adx', 'bollinger', 'donchian', 'vwapDaily', 'realizedVol'],
  mercado: ['CandleSeries', 'buildMarketView', 'buildBtcContext', 'lastIndexAtOrBefore', 'BTC_15M_CANDLES_FOR_BASELINE'],
  universo: ['selectUniverse', 'rejectContract', 'STABLECOINS'],
  señales: ['SIGNALS', 'evaluateSignals', 'computeComposite', 'entryFilters', 'sizingConfidence', 'btcVolatilityMultiplier'],
  riesgo: ['roundTripCost', 'liquidationPrice', 'planEntry', 'ceilToStep', 'checkCapacity', 'accountRules', 'EPSILON', 'lossFloor', 'checkLossFloor'],
  cuenta: ['Account'],
  exchange: ['PaperExchange', 'OrderRejectedError', 'fillPrice', 'closingSide'],
  motor: ['TradingEngine', 'AccountGuard', 'initialGuardState'],
  replay: ['runReplay', 'tuneParams', 'ReplayMarket', 'perViewScorer', 'WALK_FORWARD_DAYS'],
  aprendizaje: [
    'initialLearningState',
    'isLearningFrozen',
    'learnFromClosedTrade',
    'effectiveWeights',
    'symbolMultiplier',
    'applyWalkForward',
    'applyReliability',
    'compareShadow',
  ],
  stats: ['computeStats', 'maxDrawdown', 'bootstrapMeanCi', 'verdict'],
  frases: ['phraseOpen', 'phraseClose', 'phraseStopMoved', 'phraseWait', 'phraseLearning', 'headline', 'capitalCard', 'coinName', 'SHOWN_THRESHOLD'],
}

describe('barrel de @sereno/core', () => {
  it.each(Object.entries(REPRESENTATIVES))('publica %s', (_module, names) => {
    const missing = names.filter((name) => barrel[name] === undefined)
    expect(missing).toEqual([])
  })

  it('reexporta cada valor público de src/ con la misma referencia', async () => {
    const missing: string[] = []
    for (const file of sourceFiles(SRC)) {
      if (file === BARREL || file in INTERNAL_FILES) continue
      const internal = INTERNAL_NAMES[file] ?? {}
      for (const [name, value] of Object.entries(await exportsOf(file))) {
        if (name in internal) continue
        if (barrel[name] !== value) missing.push(`${file}: ${name}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('no deja excepciones viejas en la lista de internos', async () => {
    const files = new Set(sourceFiles(SRC))
    const stale = Object.keys(INTERNAL_FILES).filter((file) => !files.has(file))
    for (const [file, names] of Object.entries(INTERNAL_NAMES)) {
      if (!files.has(file)) {
        stale.push(file)
        continue
      }
      const exported = await exportsOf(file)
      for (const name of Object.keys(names)) if (!(name in exported)) stale.push(`${file}: ${name}`)
    }
    expect(stale).toEqual([])
  })

  it('no publica los ayudantes internos que chocan de nombre', () => {
    for (const name of ['clamp', 'formatR', 'DAY_MS']) expect(barrel).not.toHaveProperty(name)
  })

  it('sólo reexporta: importarlo no ejecuta nada propio', () => {
    const code = readFileSync(join(SRC, BARREL), 'utf8').replace(/\/\/.*$/gm, '')
    const reexport = /export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+'\.\/[^']+'\s*/g
    expect(code.replace(reexport, '').trim()).toBe('')
  })

  it('EquityPoint del barrel (stats) es el mismo tipo que el de la sombra', () => {
    expectTypeOf<core.EquityPoint>().toEqualTypeOf<ShadowEquityPoint>()
  })
})
