-- El reporte de un replay terminado (spec §9), en la fila de su sesión: null mientras
-- corre o si no terminó bien. Los listados de sesiones no lo leen (decenas de KB).
ALTER TABLE "sessions" ADD COLUMN "report" jsonb;
