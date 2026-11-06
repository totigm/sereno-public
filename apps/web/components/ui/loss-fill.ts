/**
 * Rojo lleno con texto encima, con contraste AA. En claro, `loss` con un 10% de tinta: el
 * blanco sobre `loss` puro da 4,45:1 y el texto de hasta 15 px pide 4,5 (queda en 5,1:1).
 * En oscuro, `loss` con texto `bg`.
 */
export const LOSS_FILL = 'bg-[color-mix(in_srgb,var(--loss)_90%,var(--ink))] text-surface dark:bg-loss dark:text-bg'
