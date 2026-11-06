export interface WalletMove {
  // Lo que realmente cambió el saldo.
  applied: number
  // Lo que no se pudo cobrar porque el saldo llegó a 0.
  shortfall: number
}

// Saldo de la billetera simulada. Nunca queda negativo: un débito que no alcanza se
// recorta en 0 y el resto queda registrado como faltante, para que el diario lo
// pueda contar en vez de esconderlo.
export class Wallet {
  private balance: number
  private shortfall = 0

  constructor(initialBalance: number) {
    if (!(Number.isFinite(initialBalance) && initialBalance >= 0)) {
      throw new RangeError(`saldo inicial inválido: ${initialBalance}`)
    }
    this.balance = initialBalance
  }

  get total(): number {
    return this.balance
  }

  get totalShortfall(): number {
    return this.shortfall
  }

  apply(amount: number): WalletMove {
    if (!Number.isFinite(amount)) throw new RangeError(`monto no finito: ${amount}`)
    const next = this.balance + amount
    if (next >= 0) {
      this.balance = next
      return { applied: amount, shortfall: 0 }
    }
    const shortfall = -next
    this.balance = 0
    this.shortfall += shortfall
    return { applied: amount + shortfall, shortfall }
  }
}
