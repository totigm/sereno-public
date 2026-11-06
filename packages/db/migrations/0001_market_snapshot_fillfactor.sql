-- market_snapshot tiene una sola fila viva por sesión que el bot reescribe cada ciclo.
-- Con fillfactor 50 cada página queda a la mitad para que esos UPDATE sean HOT
-- (sin tocar índices ni crecer la tabla). drizzle-kit no modela parámetros de
-- almacenamiento de tablas: por eso va en una migración a mano (spec §10).
ALTER TABLE "market_snapshot" SET (fillfactor = 50);
