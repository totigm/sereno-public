// Mientras vive, el bot pide `caffeinate -i -s` (spec §12): sin él, la Mac se duerme y el
// bot se pierde velas. `-i` evita el reposo por inactividad y `-s` el del sistema mientras
// está enchufada (macOS lo ignora a batería). `-w` ata caffeinate a este proceso: si el bot
// muere, caffeinate termina solo. `pnpm bot` es el supervisor `bin/sereno-bot.sh`, que pide
// lo mismo para cubrir las esperas entre relanzamientos. En otro sistema no hace nada.

import { spawn } from 'node:child_process'
import type { Logger } from '../logger'

export function keepAwake(logger: Logger, platform: NodeJS.Platform = process.platform): () => void {
  if (platform !== 'darwin') return () => {}
  const child = spawn('caffeinate', ['-i', '-s', '-w', String(process.pid)], { stdio: 'ignore' })
  child.on('error', (error) => logger.warn({ err: error.message }, 'No pude evitar que la Mac se duerma (caffeinate)'))
  child.unref()
  return () => {
    child.kill()
  }
}
