// Tolerancia absoluta (en USD) para comparar contra un tope o un umbral: una suma con
// residuo de coma flotante que lo cumple justo no tiene que quedar del lado equivocado.
// La comparten el plan de entrada, las reglas de capacidad y el blindaje de la cuenta.
export const EPSILON = 1e-9
