-- Preserve all legacy IDs, integer amounts, timestamps and relations without guessing units.
ALTER TABLE "fuel_prices" ALTER COLUMN "price_minor" DROP NOT NULL;
ALTER TABLE "fuel_prices"
  ADD COLUMN "provenance" TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN "provider" VARCHAR(32),
  ADD COLUMN "market" VARCHAR(2),
  ADD COLUMN "fuel_code" VARCHAR(64),
  ADD COLUMN "price" DECIMAL(30,12),
  ADD COLUMN "unit" VARCHAR(16),
  ADD COLUMN "effective_at" DATE,
  ADD COLUMN "series_key" VARCHAR(256),
  ADD COLUMN "provider_series_id" VARCHAR(240),
  ADD COLUMN "kind" VARCHAR(16),
  ADD COLUMN "interval" VARCHAR(16),
  ADD COLUMN "freshness" VARCHAR(64),
  ADD COLUMN "last_seen_at" TIMESTAMP(3);
ALTER TABLE "fuel_prices" ADD CONSTRAINT "fuel_prices_reference_metadata" CHECK (
  "provenance" = 'legacy' OR (
    "provenance" = 'external_reference' AND "price_minor" IS NULL AND
    "provider" IS NOT NULL AND "market" IS NOT NULL AND "fuel_code" IS NOT NULL AND
    "price" IS NOT NULL AND "price" > 0 AND "unit" IS NOT NULL AND
    "effective_at" IS NOT NULL AND "series_key" IS NOT NULL AND
    "kind" IS NOT NULL AND "interval" IS NOT NULL AND "last_seen_at" IS NOT NULL
  )
);
CREATE UNIQUE INDEX "fuel_prices_quote_identity" ON "fuel_prices"
  ("provider", "market", "fuel_code", "series_key", "currency", "unit", "effective_at", "price");
CREATE INDEX "fuel_prices_provider_market_effective_at_idx" ON "fuel_prices"("provider", "market", "effective_at");
CREATE TABLE "fuel_price_refreshes" (
  "key" TEXT NOT NULL PRIMARY KEY,
  "next_allowed_at" TIMESTAMP(3) NOT NULL
);
