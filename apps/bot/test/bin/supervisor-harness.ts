// Corre `bin/sereno-bot.sh` de verdad (bash, o `pnpm bot` desde la raíz) con el bot falso en
// lugar del bot y las esperas acortadas, en un directorio temporal propio por corrida. Cada
// corrida es líder de su propio grupo de procesos: así se puede simular el Ctrl-C de una
// terminal (SIGINT a todo el grupo) y limpiar lo que haya quedado vivo si un test falla.

import { execFileSync, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../../bin/sereno-bot.sh', import.meta.url))
const FAKE_BOT = fileURLToPath(new URL('./fake-bot.mjs', import.meta.url))
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

export interface SupervisorRun {
  child: ChildProcess
  // Lo que el supervisor escribió por stderr hasta ahora.
  stderr(): string
  // Las líneas que anotó el bot falso hasta ahora.
  botLog(): string[]
  // Reescribe el `.env` que lee el supervisor.
  writeEnvFile(content: string): void
  // Una señal a todo el grupo (supervisor y bot), como la de Ctrl-C en una terminal.
  signalGroup(signal: NodeJS.Signals): void
  done: Promise<SupervisorExit>
}

export interface SupervisorExit {
  code: number | null
  signal: NodeJS.Signals | null
  // El registro del bot en el instante en que salió el proceso lanzado (bash o pnpm). `done`
  // espera además a que se cierren los pipes, que el supervisor y el bot mantienen abiertos
  // mientras vivan.
  botLogAtExit: string[]
}

export interface SupervisorOptions {
  plan: string
  env?: Record<string, string>
  // Contenido de un `.env` para el supervisor; sin él apunta a uno que no existe.
  envFile?: string
  // `pnpm` lo lanza como el dueño (`pnpm bot` desde la raíz); por defecto, `bash` directo.
  via?: 'bash' | 'pnpm'
}

const tempDirs: string[] = []
const groups: number[] = []

export function startSupervisor(args: string[], options: SupervisorOptions): SupervisorRun {
  const dir = mkdtempSync(join(tmpdir(), 'sereno-supervisor-'))
  tempDirs.push(dir)
  const logPath = join(dir, 'bot.log')
  const envPath = join(dir, '.env')
  const writeEnvFile = (content: string): void => writeFileSync(envPath, content)
  if (options.envFile !== undefined) writeEnvFile(options.envFile)
  chmodSync(FAKE_BOT, 0o755)

  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('SERENO_') && !key.startsWith('FAKE_BOT_')) env[key] = value
  }
  // Lo pone pnpm al correr un script; el supervisor lo mira para saber si lo lanzó pnpm.
  delete env.npm_lifecycle_event
  Object.assign(env, {
    SERENO_BOT_COMMAND: FAKE_BOT,
    SERENO_ENV_FILE: envPath,
    SERENO_RESTART_BASE_MS: '20',
    SERENO_RESTART_MAX_MS: '80',
    FAKE_BOT_LOG: logPath,
    FAKE_BOT_PLAN: options.plan,
    ...options.env,
  })

  const [command, commandArgs] = options.via === 'pnpm' ? ['pnpm', ['bot', ...args]] : ['bash', [SCRIPT, ...args]]
  const child = spawn(command, commandArgs, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  const pgid = child.pid
  if (pgid === undefined) throw new Error(`no pude arrancar ${command}`)
  groups.push(pgid)
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })
  child.stdout.resume()
  const botLog = (): string[] => (existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n').filter(Boolean) : [])
  const exited = new Promise<SupervisorExit>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal, botLogAtExit: botLog() }))
  })
  const closed = new Promise<void>((resolve) => child.on('close', () => resolve()))
  const done = Promise.all([exited, closed]).then(([exit]) => exit)
  const signalGroup = (signal: NodeJS.Signals): void => {
    process.kill(-pgid, signal)
  }
  return { child, stderr: () => stderr, botLog, writeEnvFile, signalGroup, done }
}

export function cleanupRuns(): void {
  for (const pgid of groups.splice(0)) {
    try {
      process.kill(-pgid, 'SIGKILL')
    } catch {
      // El grupo ya no existe: todo terminó solo.
    }
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

export async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('waitFor: la condición no se cumplió a tiempo')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

export function starts(log: string[]): string[] {
  return log.filter((line) => line.startsWith('start'))
}

// Las esperas que anunció el supervisor antes de cada relanzamiento ("0,02 s", "1 s"…).
export function announcedDelays(stderr: string): string[] {
  return [...stderr.matchAll(/lo relanzo en ([\d,]+ s)/g)].map((match) => match[1] ?? '')
}

// El pid del `caffeinate -w <pid>` que el supervisor ata a sí mismo, si existe.
export function caffeinateOf(supervisorPid: number): number | undefined {
  try {
    const out = execFileSync('pgrep', ['-f', `^caffeinate -i -s -w ${supervisorPid}$`], { encoding: 'utf8' })
    const pid = Number(out.trim().split('\n')[0])
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

// Vivo de verdad: `kill -0` también da vivo a un zombi que su padre todavía no recogió.
export function isRunning(pid: number): boolean {
  try {
    const stat = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim()
    return stat !== '' && !stat.startsWith('Z')
  } catch {
    return false
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
