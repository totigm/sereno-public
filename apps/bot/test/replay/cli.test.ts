import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeBinance } from '../../src/binance/fake/server'
import { parseReplayArgs } from '../../src/replay/cli'
import { openTestDb, TEST_URL, type TestDb } from '../helpers/db'

const BOT_DIR = fileURLToPath(new URL('../..', import.meta.url))

let fake: FakeBinance
let t: TestDb
let sessionId: string | null = null

beforeAll(async () => {
  fake = await FakeBinance.start()
  t = await openTestDb()
})

afterAll(async () => {
  if (sessionId) await t.query('delete from sessions where id = $1', [sessionId])
  await fake.stop()
  await t.close()
})

function runCli(args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', ['exec', 'tsx', 'src/index.ts', 'replay', ...args], {
      cwd: BOT_DIR,
      env: { ...process.env, DATABASE_URL: TEST_URL, DATABASE_URL_UNPOOLED: TEST_URL, BINANCE_REST_URL: fake.baseUrl, LOG_LEVEL: 'warn' },
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stderr }))
  })
}

describe('pnpm bot replay', () => {
  it('--days 3 --capital 1000 corre un replay contra DATABASE_URL y lo deja listo', async () => {
    fake.reset()
    const { code, stderr } = await runCli(['--days', '3', '--capital', '1000'])

    expect(stderr).toMatch(/replay ses_[\w-]+: 3 días con 1000 USDT/)
    sessionId = /replay (ses_[\w-]+):/.exec(stderr)?.[1] ?? null
    expect(code).toBe(0)
    const row = await t.repos.sessions.get(sessionId!)
    expect(row).toMatchObject({ kind: 'replay', status: 'listo', progreso: 1, capitalInicial: 1000, replayParams: { days: 3, capital: 1000, learningOrigin: 'zero', paramTuning: false } })
    expect((await t.repos.sessions.getReport(sessionId!))?.days).toBe(3)
    // Soltó el lease al terminar.
    expect(await t.repos.bot.acquireLease(sessionId!, 'otra-instancia', 30_000)).toBe(true)
  }, 120_000)

  it('valida los argumentos', () => {
    expect(parseReplayArgs(['--days', '7', '--capital', '500', '--learning', 'current', '--tuning'])).toEqual({ days: 7, capital: 500, learningOrigin: 'current', paramTuning: true })
    expect(parseReplayArgs([])).toEqual({ days: 90, capital: 1000, learningOrigin: 'zero', paramTuning: false })
    expect(() => parseReplayArgs(['--days', '0'])).toThrow(/--days/)
    expect(() => parseReplayArgs(['--capital', '-5'])).toThrow(/--capital/)
    expect(() => parseReplayArgs(['--learning', 'todo'])).toThrow(/--learning/)
  })
})
