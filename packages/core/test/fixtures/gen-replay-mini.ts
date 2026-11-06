// Genera `replay-mini.json` al lado de este archivo: BTCUSDT y ETHUSDT del 1 al 6/10/2026
// con calentamiento, caminata aleatoria con regímenes de tendencia y semilla fija.
//   pnpm exec tsx packages/core/test/fixtures/gen-replay-mini.ts
// Con la misma semilla el JSON sale idéntico byte a byte: los tests del replay dependen de
// sus trades (cantidad, lados, el día sin BTC, el OI que llega el tercer día).
import { writeFileSync } from 'node:fs'

const SEED = 7

interface SymbolConfig {
  start: number
  decimals: number
  vol: number
  sigma: number
}

interface Row {
  t: number
  o: number
  h: number
  l: number
  c: number
  v: number
}

type FundingRow = [at: number, rate: number, markPrice: number]

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rnd = mulberry32(SEED)
// Box-Muller: una normal estándar con dos uniformes del mismo generador.
const gauss = (): number => {
  const u = Math.max(rnd(), 1e-12)
  const v = rnd()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

const MIN = 60_000
const M15 = 15 * MIN
const H1 = 60 * MIN
const H4 = 4 * H1
const DAY = 24 * H1
const FROM = Date.UTC(2026, 9, 1)
const TO = FROM + 5 * DAY
// Bastante antes de FROM para que entren 300 velas de 4h de calentamiento.
const GEN_START = FROM - 51 * DAY
const REGIMES = [-0.0014, -0.0008, -0.0003, 0, 0.0003, 0.0008, 0.0014] as const

const SYMBOLS: Record<string, SymbolConfig> = {
  BTCUSDT: { start: 60000, decimals: 1, vol: 12, sigma: 0.0022 },
  ETHUSDT: { start: 2500, decimals: 2, vol: 300, sigma: 0.0028 },
}

const round = (x: number, decimals: number): number => Number(x.toFixed(decimals))

function at<T>(xs: readonly T[], i: number): T {
  const x = xs[i]
  if (x === undefined) throw new RangeError(`índice ${i} fuera de rango`)
  return x
}

function gen15m(cfg: SymbolConfig): Row[] {
  const out: Row[] = []
  let price = cfg.start
  let drift = 0
  let left = 0
  for (let t = GEN_START; t < TO; t += M15) {
    if (left <= 0) {
      drift = at(REGIMES, Math.floor(rnd() * REGIMES.length))
      left = 24 + Math.floor(rnd() * 120)
    }
    left--
    const open = price
    const close = open * Math.exp(drift + cfg.sigma * gauss())
    const wickUp = Math.abs(gauss()) * cfg.sigma * 0.6
    const wickDown = Math.abs(gauss()) * cfg.sigma * 0.6
    const high = Math.max(open, close) * (1 + wickUp)
    const low = Math.min(open, close) * (1 - wickDown)
    const move = Math.abs(Math.log(close / open)) / cfg.sigma
    const volume = cfg.vol * (0.7 + 0.6 * rnd()) * (0.8 + 0.4 * move)
    out.push({ t, o: open, h: high, l: low, c: close, v: volume })
    price = close
  }
  return out
}

function aggregate(rows: readonly Row[], span: number): Row[] {
  const out: Row[] = []
  for (let i = 0; i < rows.length; ) {
    const first = at(rows, i)
    const t = first.t - ((first.t - GEN_START) % span)
    const group: Row[] = []
    while (i < rows.length && at(rows, i).t < t + span) group.push(at(rows, i++))
    out.push({ t, o: first.o, h: Math.max(...group.map((r) => r.h)), l: Math.min(...group.map((r) => r.l)), c: at(group, group.length - 1).c, v: group.reduce((a, r) => a + r.v, 0) })
  }
  return out
}

const fixture = {
  _note:
    'Datos sintéticos (caminata aleatoria con regímenes de tendencia, semilla fija) para el test de determinismo del replay. Velas compactas: [open, high, low, close, volume] desde `start` cada `span` ms; la marca de 15m es [open, high, low, close]. funding: [at, rate, markPrice]. futures: [at, fundingRate, nextFundingTime, openInterest, openInterest1hAgo, openInterest4hAgo, longShortRatio, takerRatio]. Generado por gen-replay-mini.ts (pnpm exec tsx packages/core/test/fixtures/gen-replay-mini.ts).',
  from: FROM,
  to: TO,
  symbolsByDay: {} as Record<string, string[]>,
  infos: {} as Record<string, unknown>,
  series: {} as Record<string, unknown>,
  funding: {} as Record<string, FundingRow[]>,
  futures: {} as Record<string, (number | null)[][]>,
}

// El cuarto día el universo es sólo ETH: BTC aparece si tenía una abierta.
for (let d = 0; d < 5; d++) {
  const day = new Date(FROM + d * DAY).toISOString().slice(0, 10)
  fixture.symbolsByDay[day] = d === 3 ? ['ETHUSDT'] : ['ETHUSDT', 'BTCUSDT']
}

for (const [symbol, cfg] of Object.entries(SYMBOLS)) {
  const m15 = gen15m(cfg)
  const keep = (rows: readonly Row[], span: number): Row[] => rows.filter((r) => r.t >= FROM - 300 * span && r.t < TO)
  const k15 = keep(m15, M15)
  const k1 = keep(aggregate(m15, H1), H1)
  const k4 = keep(aggregate(m15, H4), H4)
  const d = cfg.decimals
  const pack = (rows: readonly Row[]): number[][] => rows.map((r) => [round(r.o, d), round(r.h, d), round(r.l, d), round(r.c, d), round(r.v, 3)])
  // La marca sigue al último precio con una base que deriva entre −0,08% y +0,04%.
  let basis = -0.0002
  const mark = k15.map((r) => {
    basis = Math.max(-0.0008, Math.min(0.0004, basis + 0.00008 * gauss()))
    const f = 1 + basis
    return [round(r.o * f, d), round(r.h * f, d), round(r.l * f, d), round(r.c * f, d)]
  })
  const start15m = at(k15, 0).t
  fixture.series[symbol] = {
    '15m': { start: start15m, span: M15, last: pack(k15), mark },
    '1h': { start: at(k1, 0).t, span: H1, last: pack(k1) },
    '4h': { start: at(k4, 0).t, span: H4, last: pack(k4) },
  }
  const markAt = (t: number): number => at(at(mark, (t - start15m) / M15), 0)
  const funding: FundingRow[] = []
  let rate = 0.0001
  for (let t = FROM; t < TO; t += 8 * H1) {
    rate = Math.max(-0.0008, Math.min(0.0008, rate + 0.00015 * gauss()))
    // Binance a veces informa el funding unos ms después del borde de la vela.
    const fundingAt = t + (funding.length % 3 === 1 ? 3 : 0)
    funding.push([fundingAt, Number(rate.toFixed(6)), markAt(t)])
  }
  fixture.funding[symbol] = funding
  // Datos de futuros (OI y ratios) desde el tercer día: antes, esas señales faltan.
  const futures: (number | null)[][] = []
  let oi = cfg.vol * 2000
  const history: number[] = []
  for (let t = FROM + 2 * DAY; t < TO; t += H1) {
    oi = oi * Math.exp(0.01 * gauss())
    history.push(oi)
    const ago = (n: number): number | null => history[history.length - 1 - n] ?? null
    const ago1 = ago(1)
    const ago4 = ago(4)
    const current = funding.filter((f) => f[0] <= t).at(-1)
    const next = Math.ceil((t + 1) / (8 * H1)) * 8 * H1
    futures.push([
      t,
      current ? current[1] : null,
      next,
      round(oi, 1),
      ago1 && round(ago1, 1),
      ago4 && round(ago4, 1),
      round(0.8 + 1.6 * rnd(), 3),
      round(0.6 + 0.9 * rnd(), 3),
    ])
  }
  fixture.futures[symbol] = futures
  fixture.infos[symbol] = {
    symbol,
    baseAsset: symbol.replace(/USDT$/, ''),
    minNotional: symbol === 'BTCUSDT' ? 100 : 20,
    minQty: 0.001,
    stepSize: 0.001,
    tickSize: symbol === 'BTCUSDT' ? 0.1 : 0.01,
    quantityPrecision: 3,
    mmr: symbol === 'BTCUSDT' ? 0.004 : 0.005,
    liquidationFee: 0.0125,
    fundingIntervalHours: 8,
    halfSpreadRate: 0.0001,
    underlyingType: 'COIN',
    underlyingSubType: [],
    onboardDate: Date.UTC(2019, 8, 8),
  }
}

writeFileSync(new URL('./replay-mini.json', import.meta.url), JSON.stringify(fixture))
