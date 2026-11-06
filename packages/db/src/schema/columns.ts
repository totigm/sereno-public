import { timestamp } from 'drizzle-orm/pg-core'

// Todas las fechas de la base van con zona horaria y salen como `Date`. Los
// instantes del motor (números en ms) se convierten en el borde de los repositorios.
export const timestamptz = () => timestamp({ withTimezone: true, mode: 'date' })
