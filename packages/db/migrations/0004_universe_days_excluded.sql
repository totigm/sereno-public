-- Las monedas que quedaron afuera del universo ese día, con su motivo:
-- `{ [symbol]: { reason, detail?, pinned? } }` (por filtro y fijadas que no entraron).
ALTER TABLE "universe_days" ADD COLUMN "excluded" jsonb DEFAULT '{}'::jsonb NOT NULL;
