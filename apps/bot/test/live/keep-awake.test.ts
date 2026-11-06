import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLogger } from '../../src/logger'
import { keepAwake } from '../../src/live/keep-awake'
import { logSink } from '../helpers/log-sink'

// Sin lanzar caffeinate de verdad: los argumentos son lo que promete el README.
const spawned = vi.hoisted(() => [] as { command: string; args: string[]; child: FakeChild }[])

interface FakeChild extends EventEmitter {
  unref: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
}

vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn(), kill: vi.fn() })
    spawned.push({ command, args, child })
    return child
  },
}))

afterEach(() => {
  spawned.length = 0
})

describe('keepAwake', () => {
  it('en macOS pide caffeinate -i -s atado al pid del bot y lo suelta al apagar', () => {
    const stop = keepAwake(createLogger({ level: 'silent' }), 'darwin')
    expect(spawned.map(({ command, args }) => [command, args])).toEqual([
      ['caffeinate', ['-i', '-s', '-w', String(process.pid)]],
    ])
    const child = spawned[0]?.child
    expect(child?.unref).toHaveBeenCalledOnce()
    expect(child?.kill).not.toHaveBeenCalled()
    stop()
    expect(child?.kill).toHaveBeenCalledOnce()
  })

  it('en otro sistema no lanza nada', () => {
    const stop = keepAwake(createLogger({ level: 'silent' }), 'linux')
    stop()
    expect(spawned).toEqual([])
  })

  it('el supervisor y los comentarios del arranque piden lo mismo: caffeinate -i -s', () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
    expect(read('../../bin/sereno-bot.sh')).toContain('caffeinate -i -s -w $$')
    for (const path of ['../../Dockerfile', '../../src/live/keep-awake.ts']) {
      const text = read(path)
      expect(text).toContain('sereno-bot.sh')
      expect(text).toContain('caffeinate -i -s')
      // Ni `caffeinate -i` a secas ni `pnpm bot` como si corriera el bot directo.
      expect(text).not.toMatch(/caffeinate -i(?! -s)/)
      expect(text).not.toMatch(/`pnpm bot`;/)
    }
  })

  it('si caffeinate no arranca, avisa y el bot sigue', () => {
    const sink = logSink()
    keepAwake(createLogger({ destination: sink.stream }), 'darwin')
    spawned[0]?.child.emit('error', new Error('spawn caffeinate ENOENT'))
    expect(sink.lines()).toEqual([
      expect.objectContaining({ level: 40, err: 'spawn caffeinate ENOENT', msg: 'No pude evitar que la Mac se duerma (caffeinate)' }),
    ])
  })
})
