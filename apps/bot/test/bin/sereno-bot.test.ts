import { afterEach, describe, expect, it } from 'vitest'
import {
  announcedDelays,
  caffeinateOf,
  cleanupRuns,
  isAlive,
  isRunning,
  startSupervisor,
  starts,
  waitFor,
} from './supervisor-harness'

afterEach(cleanupRuns)

describe('bin/sereno-bot.sh: en vivo', () => {
  it('relanza al bot cuando sale con error y termina cuando sale con 0', async () => {
    const run = startSupervisor([], { plan: '1,1,0' })
    const { code } = await run.done
    expect(code).toBe(0)
    expect(starts(run.botLog())).toEqual(['start', 'start', 'start'])
    expect(run.stderr()).toMatch(/el bot salió con código 1; lo relanzo en 0,02 s/)
  })

  it('no relanza cuando el bot sale con 0', async () => {
    const run = startSupervisor(['live'], { plan: '0' })
    const { code } = await run.done
    expect(code).toBe(0)
    expect(starts(run.botLog())).toEqual(['start live'])
    expect(announcedDelays(run.stderr())).toEqual([])
  })

  it('pasa los argumentos tal cual en cada relanzamiento', async () => {
    const run = startSupervisor(['live'], { plan: '2,0' })
    expect((await run.done).code).toBe(0)
    expect(starts(run.botLog())).toEqual(['start live', 'start live'])
    expect(run.stderr()).toMatch(/código 2/)
  })

  it('duplica la espera entre relanzamientos hasta el tope', async () => {
    const run = startSupervisor([], { plan: '1,1,1,1,0', env: { SERENO_RESTART_MAX_MS: '50' } })
    expect((await run.done).code).toBe(0)
    expect(announcedDelays(run.stderr())).toEqual(['0,02 s', '0,04 s', '0,05 s', '0,05 s'])
  })

  it('vuelve a la espera inicial si el bot anduvo bien el tiempo de reseteo', async () => {
    // El supervisor mide en segundos enteros: con 2 s de reseteo, una corrida breve que
    // cruza un cambio de segundo no llega y una de 2,1 s siempre llega.
    const run = startSupervisor([], {
      plan: '1,1,1@2100,1,0',
      env: { SERENO_RESTART_MAX_MS: '1000', SERENO_RESTART_RESET_S: '2' },
    })
    expect((await run.done).code).toBe(0)
    expect(announcedDelays(run.stderr())).toEqual(['0,02 s', '0,04 s', '0,02 s', '0,04 s'])
  })
})

describe('bin/sereno-bot.sh: apagado', () => {
  it('reenvía SIGTERM al bot, espera a que suelte el lease y no lo relanza', async () => {
    const run = startSupervisor([], { plan: 'wait', env: { FAKE_BOT_SHUTDOWN_MS: '400' } })
    await waitFor(() => starts(run.botLog()).length === 1)
    run.child.kill('SIGTERM')
    const { code, botLogAtExit } = await run.done
    // Si el supervisor no esperara, saldría antes de que el bot anote "released".
    expect(botLogAtExit.filter((line) => !line.startsWith('pid'))).toEqual(['start', 'term', 'released'])
    expect(code).toBe(0)
    expect(run.stderr()).toMatch(/apagando: espero a que el bot guarde lo pendiente.*\(otro Ctrl-C lo corta ya\)/)
    expect(run.stderr()).toMatch(/el bot se apagó y soltó la sesión/)
  })

  it('SIGHUP (la terminal que se cierra) apaga ordenado, igual que SIGTERM', async () => {
    const run = startSupervisor([], { plan: 'wait', env: { FAKE_BOT_SHUTDOWN_MS: '300' } })
    await waitFor(() => starts(run.botLog()).length === 1)
    run.child.kill('SIGHUP')
    const { code, botLogAtExit } = await run.done
    expect(botLogAtExit.filter((line) => !line.startsWith('pid'))).toEqual(['start', 'term', 'released'])
    expect(code).toBe(0)
  })

  it('cerrar la terminal (SIGHUP a todo el grupo) corta al bot y no lo relanza', async () => {
    const run = startSupervisor([], { plan: 'wait', env: { FAKE_BOT_SHUTDOWN_MS: '300' } })
    await waitFor(() => starts(run.botLog()).length === 1)
    run.signalGroup('SIGHUP')
    const { code } = await run.done
    // El bot no escucha SIGHUP: muere sin soltar la sesión. El supervisor lo cuenta y termina.
    expect(code).toBe(129)
    expect(run.botLog().filter((line) => !line.startsWith('pid'))).toEqual(['start'])
    expect(run.stderr()).toMatch(/el bot terminó con código 129 durante el apagado/)
  })

  it('un SIGHUP durante el apagado no cuenta como el segundo aviso que corta', async () => {
    const run = startSupervisor([], { plan: 'wait', env: { FAKE_BOT_SHUTDOWN_MS: '400' } })
    await waitFor(() => starts(run.botLog()).length === 1)
    run.child.kill('SIGTERM')
    await waitFor(() => run.botLog().includes('term'))
    run.child.kill('SIGHUP')
    const { code, botLogAtExit } = await run.done
    expect(botLogAtExit.filter((line) => !line.startsWith('pid'))).toEqual(['start', 'term', 'released'])
    expect(code).toBe(0)
    expect(run.stderr()).not.toMatch(/corto el bot/)
  })

  it.runIf(process.platform === 'darwin')('la Mac sigue despierta durante el apagado tras un Ctrl-C', async () => {
    const run = startSupervisor([], { plan: 'wait', env: { FAKE_BOT_SHUTDOWN_MS: '400' } })
    await waitFor(() => starts(run.botLog()).length === 1)
    const supervisorPid = run.child.pid ?? 0
    await waitFor(() => caffeinateOf(supervisorPid) !== undefined)
    const caffeinate = caffeinateOf(supervisorPid) ?? 0
    run.signalGroup('SIGINT')
    await waitFor(() => run.botLog().includes('term'))
    // El Ctrl-C le llega a todo el grupo; el caffeinate del supervisor tiene que sobrevivir
    // para cubrir el apagado, y terminar con el supervisor.
    expect(isRunning(caffeinate)).toBe(true)
    expect((await run.done).code).toBe(0)
    await waitFor(() => !isRunning(caffeinate))
  })

  it('con el Ctrl-C de la terminal (SIGINT a todo el grupo) el bot se apaga una sola vez', async () => {
    const run = startSupervisor([], { plan: 'wait', env: { FAKE_BOT_SHUTDOWN_MS: '300' } })
    await waitFor(() => starts(run.botLog()).length === 1)
    run.signalGroup('SIGINT')
    const { code, botLogAtExit } = await run.done
    // El bot ya recibió SIGINT de la terminal: si el supervisor le reenviara otro SIGINT, lo
    // mataría a mitad del apagado. Le manda SIGTERM, que el apagado en curso ignora.
    expect(botLogAtExit.filter((line) => !line.startsWith('pid'))).toEqual(['start', 'term', 'released'])
    expect(code).toBe(0)
  })

  it('un segundo aviso mata al bot sin esperar', async () => {
    const run = startSupervisor([], { plan: 'stuck' })
    await waitFor(() => starts(run.botLog()).length === 1)
    const pid = Number(run.botLog().find((line) => line.startsWith('pid'))?.slice(4))
    run.child.kill('SIGTERM')
    await waitFor(() => run.botLog().includes('term'))
    run.child.kill('SIGINT')
    const { code } = await run.done
    expect(code).toBe(137)
    expect(isAlive(pid)).toBe(false)
    expect(run.stderr()).toMatch(/corto el bot sin esperar/)
    expect(starts(run.botLog())).toHaveLength(1)
  })

  it('un aviso durante la espera entre relanzamientos termina sin relanzar', async () => {
    const run = startSupervisor([], { plan: '1,0', env: { SERENO_RESTART_BASE_MS: '5000', SERENO_RESTART_MAX_MS: '5000' } })
    await waitFor(() => /lo relanzo en 5 s/.test(run.stderr()))
    const signalledAt = Date.now()
    run.child.kill('SIGTERM')
    const { code } = await run.done
    expect(Date.now() - signalledAt).toBeLessThan(1_000)
    expect(code).toBe(0)
    expect(starts(run.botLog())).toHaveLength(1)
    expect(run.stderr()).toMatch(/apagando: no lo relanzo/)
  })
})

describe('bin/sereno-bot.sh: lanzado con pnpm bot', () => {
  it('pnpm sale con el Ctrl-C sin esperar; el supervisor termina el apagado y dice cómo cortarlo', async () => {
    const run = startSupervisor([], { plan: 'wait', via: 'pnpm', env: { FAKE_BOT_SHUTDOWN_MS: '800' } })
    await waitFor(() => starts(run.botLog()).length === 1, 10_000)
    run.signalGroup('SIGINT')
    const { botLogAtExit } = await run.done
    // pnpm 12 no espera al hijo (README, "Correr el bot 24/7 en la Mac"): si esto falla
    // porque ahora sí espera, hay que corregir el README y el aviso del supervisor.
    expect(botLogAtExit).not.toContain('released')
    expect(run.botLog().filter((line) => !line.startsWith('pid'))).toEqual(['start', 'term', 'released'])
    expect(run.stderr()).toMatch(/apagando: espero a que el bot guarde lo pendiente.*\(para cortarlo ya: kill \d+\)/)
    expect(run.stderr()).not.toMatch(/otro Ctrl-C/)
    expect(run.stderr()).toMatch(/el bot se apagó y soltó la sesión/)
  }, 15_000)
})

describe('bin/sereno-bot.sh: replay y entorno', () => {
  it('corre el replay una sola vez aunque falle, con sus argumentos', async () => {
    const run = startSupervisor(['replay', '--days', '90'], { plan: '3,0' })
    const { code } = await run.done
    expect(code).toBe(3)
    expect(starts(run.botLog())).toEqual(['start replay --days 90'])
    expect(announcedDelays(run.stderr())).toEqual([])
  })

  it('carga el .env sin pisar lo que ya está en el entorno y sin imprimir valores', async () => {
    const envFile = [
      '# comentario',
      '',
      'PLAIN=simple',
      'QUOTED="con espacios"   # comentario',
      "SINGLE='literal $HOME'",
      'export EXPORTED=exportada',
      'TRAILING=valor # comentario',
      'CRLF=windows\r',
      'EMPTY=',
      'KEPT=del-archivo',
      'no es una variable',
    ].join('\n')
    const run = startSupervisor([], {
      plan: '0',
      envFile,
      env: { KEPT: 'del-entorno', FAKE_BOT_PRINT_ENV: 'PLAIN,QUOTED,SINGLE,EXPORTED,TRAILING,CRLF,EMPTY,KEPT' },
    })
    expect((await run.done).code).toBe(0)
    expect(run.botLog().filter((line) => line.startsWith('env'))).toEqual([
      'env PLAIN=simple',
      'env QUOTED=con espacios',
      'env SINGLE=literal $HOME',
      'env EXPORTED=exportada',
      'env TRAILING=valor',
      'env CRLF=windows',
      'env EMPTY=',
      'env KEPT=del-entorno',
    ])
    expect(run.stderr()).not.toMatch(/simple|espacios|exportada|del-archivo/)
  })

  it('vuelve a leer el .env en cada arranque', async () => {
    const run = startSupervisor([], {
      plan: '1,0',
      envFile: 'VERSION=primera',
      env: { SERENO_RESTART_BASE_MS: '300', FAKE_BOT_PRINT_ENV: 'VERSION' },
    })
    await waitFor(() => /lo relanzo/.test(run.stderr()))
    run.writeEnvFile('VERSION=segunda')
    expect((await run.done).code).toBe(0)
    expect(run.botLog().filter((line) => line.startsWith('env'))).toEqual(['env VERSION=primera', 'env VERSION=segunda'])
  })
})
