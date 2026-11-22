-- Additive checkout storage; never infer currency or fulfillment of legacy rows.
BEGIN;
CREATE TABLE "selling_prices" (
  "id" SERIAL PRIMARY KEY,
  "fuel_type_id" INTEGER NOT NULL REFERENCES "fuel_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "currency" VARCHAR(3) NOT NULL,
  "unit_price_minor" INTEGER NOT NULL,
  "effective_at" TIMESTAMPTZ(3) NOT NULL,
  "created_by" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "selling_prices_currency_check" CHECK ("currency" IN ('USD', 'LBP')),
  CONSTRAINT "selling_prices_positive_price" CHECK ("unit_price_minor" > 0)
);
CREATE UNIQUE INDEX "selling_prices_fuel_type_id_currency_effective_at_key" ON "selling_prices"("fuel_type_id", "currency", "effective_at");

CREATE TABLE "order_quotes" (
  "id" UUID PRIMARY KEY,
  "station_id" INTEGER NOT NULL REFERENCES "stations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "fuel_type_id" INTEGER NOT NULL REFERENCES "fuel_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "selling_price_id" INTEGER NOT NULL REFERENCES "selling_prices"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "customer_id" INTEGER REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "guest_token_hash" CHAR(64),
  "fulfillment_type" TEXT NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "unit_price_minor" INTEGER NOT NULL,
  "quantity" DECIMAL(12,3) NOT NULL,
  "total_minor" INTEGER NOT NULL,
  "input_mode" TEXT NOT NULL,
  "requested_value" VARCHAR(32) NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "order_quotes_identity_check" CHECK (("customer_id" IS NULL) <> ("guest_token_hash" IS NULL)),
  CONSTRAINT "order_quotes_guest_fulfillment" CHECK ("customer_id" IS NOT NULL OR "fulfillment_type" = 'IN_STATION'),
  CONSTRAINT "order_quotes_currency_check" CHECK ("currency" IN ('USD', 'LBP')),
  CONSTRAINT "order_quotes_fulfillment_check" CHECK ("fulfillment_type" IN ('IN_STATION', 'PICKUP')),
  CONSTRAINT "order_quotes_mode_check" CHECK ("input_mode" IN ('AMOUNT', 'LITERS')),
  CONSTRAINT "order_quotes_positive_values" CHECK ("unit_price_minor" > 0 AND "quantity" > 0 AND "total_minor" > 0),
  CONSTRAINT "order_quotes_expiry_check" CHECK ("expires_at" > "created_at")
);
CREATE INDEX "order_quotes_expires_at_idx" ON "order_quotes"("expires_at");

ALTER TABLE "orders" ALTER COLUMN "pump_id" DROP NOT NULL;
ALTER TABLE "orders"
  ADD COLUMN "currency" VARCHAR(3),
  ADD COLUMN "fulfillment_type" TEXT,
  ADD COLUMN "quote_id" UUID,
  ADD COLUMN "creation_key" UUID,
  ADD COLUMN "creation_request_hash" CHAR(64);
CREATE UNIQUE INDEX "orders_quote_id_key" ON "orders"("quote_id");
CREATE UNIQUE INDEX "orders_creation_key_key" ON "orders"("creation_key");
ALTER TABLE "orders" ADD CONSTRAINT "orders_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "order_quotes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_checkout_snapshot_check" CHECK (
  "quote_id" IS NULL OR (
    "currency" IS NOT NULL AND "currency" IN ('USD', 'LBP') AND
    "fulfillment_type" IS NOT NULL AND "fulfillment_type" IN ('IN_STATION', 'PICKUP') AND
    "creation_key" IS NOT NULL AND "creation_request_hash" IS NOT NULL AND
    "unit_price_minor" > 0 AND "ordered_volume" > 0 AND "ordered_amount_minor" > 0
  )
);
COMMIT;
