// Logs estructurados del bot (pino, spec §12). JSON por línea en producción; en una
// terminal interactiva se puede pedir `pretty` (pino-pretty corre en un worker).

import pino from 'pino'
import type { DestinationStream, Logger } from 'pino'

export type { Logger }

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

export interface LoggerOptions {
  level?: LogLevel
  name?: string
  // Salida legible para humanos (sólo con terminal); incompatible con `destination`.
  pretty?: boolean
  destination?: DestinationStream
}

export function createLogger({ level = 'info', name = 'sereno', pretty = false, destination }: LoggerOptions = {}): Logger {
  if (destination) return pino({ name, level }, destination)
  if (pretty) {
    return pino({
      name,
      level,
      transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } },
    })
  }
  return pino({ name, level })
}

// Para módulos que aceptan un logger opcional: no escribe nada.
export const silentLogger: Logger = createLogger({ level: 'silent' })

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value)
}
