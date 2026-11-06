#!/usr/bin/env node
// Bot falso para los tests del supervisor (`bin/sereno-bot.sh`). Anota en FAKE_BOT_LOG cada
// arranque con sus argumentos y su pid, y se comporta según el guion de FAKE_BOT_PLAN: una
// entrada por arranque separada por comas (la última se repite):
//   <código>[@<ms>]  sale con ese código (después de esos milisegundos)
//   wait             sigue vivo; con SIGTERM o SIGINT anota "term", tarda FAKE_BOT_SHUTDOWN_MS
//                    en "soltar el lease" (anota "released") y sale con 0
//   stuck            sigue vivo; con SIGTERM o SIGINT anota "term" y nunca sale
// Como el bot real (`src/live/shutdown.ts`), escucha cada señal una sola vez: una segunda
// del mismo tipo lo mata.
// FAKE_BOT_PRINT_ENV=A,B anota "env A=<valor>" por cada variable (o "env A unset").

import { appendFileSync, existsSync, readFileSync } from 'node:fs'

const logPath = process.env.FAKE_BOT_LOG
const note = (line) => appendFileSync(logPath, `${line}\n`)

const previousRuns = existsSync(logPath)
  ? readFileSync(logPath, 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('start')).length
  : 0
const plan = (process.env.FAKE_BOT_PLAN ?? '0').split(',')
const step = plan[Math.min(previousRuns, plan.length - 1)]

if (step === 'wait' || step === 'stuck') {
  const keepAlive = setInterval(() => {}, 60_000)
  let stopping = false
  const onSignal = () => {
    if (stopping) return
    stopping = true
    note('term')
    if (step === 'stuck') return
    setTimeout(() => {
      note('released')
      clearInterval(keepAlive)
      process.exit(0)
    }, Number(process.env.FAKE_BOT_SHUTDOWN_MS ?? 0))
  }
  process.once('SIGTERM', onSignal)
  process.once('SIGINT', onSignal)
} else {
  const [code, afterMs = '0'] = step.split('@')
  setTimeout(() => process.exit(Number(code)), Number(afterMs))
}

// "start" es la señal de listo de los tests: va después de escuchar las señales, así un
// aviso que llega apenas aparece no encuentra al bot sin sus manejadores.
note(['start', ...process.argv.slice(2)].join(' '))
note(`pid ${process.pid}`)
for (const name of (process.env.FAKE_BOT_PRINT_ENV ?? '').split(',').filter(Boolean)) {
  const value = process.env[name]
  note(value === undefined ? `env ${name} unset` : `env ${name}=${value}`)
}
