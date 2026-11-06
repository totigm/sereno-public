-- Los comandos sin parámetros (close_all, release_protected, reset_learning) se
-- encolan sin payload: la fila queda con `{}`, nunca null.
ALTER TABLE "bot_commands" ALTER COLUMN "payload" SET DEFAULT '{}'::jsonb;
