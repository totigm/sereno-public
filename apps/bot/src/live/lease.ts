// Instancia única por sesión (spec §10 y §12): sólo opera el proceso que tiene el lease.
// Se renueva con cada latido (cada 10 s) y vence a los 30 s: si el proceso se cuelga o
// se corta, otro lo puede tomar sin esperar mucho; si se apaga ordenadamente, lo suelta.

import type { BotRepo } from '@sereno/db'

export const LEASE_TTL_MS = 30_000

export class Lease {
  constructor(
    private readonly bot: Pick<BotRepo, 'acquireLease' | 'releaseLease'>,
    readonly instanceId: string,
  ) {}

  // Toma o renueva el lease de la sesión; false si lo tiene otra instancia viva.
  take(sessionId: string): Promise<boolean> {
    return this.bot.acquireLease(sessionId, this.instanceId, LEASE_TTL_MS)
  }

  async release(sessionId: string): Promise<void> {
    await this.bot.releaseLease(sessionId, this.instanceId)
  }
}
