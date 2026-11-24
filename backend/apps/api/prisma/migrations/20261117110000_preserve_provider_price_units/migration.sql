-- Widen scale without reducing integer capacity or rounding existing values.
ALTER TABLE "fuel_prices" ALTER COLUMN "price" TYPE DECIMAL(32,14);
-- Nullable for legacy/pre-provenance observations; never invent original quote metadata.
ALTER TABLE "fuel_prices"
  ADD COLUMN "provider_fuel_code" VARCHAR(64),
  ADD COLUMN "provider_price" DECIMAL(30,12),
  ADD COLUMN "provider_unit" VARCHAR(16),
  ADD COLUMN "conversion_divisor" INTEGER;
ALTER TABLE "fuel_prices" ADD CONSTRAINT "fuel_prices_conversion_metadata" CHECK (
  ("provider_fuel_code" IS NULL AND "provider_price" IS NULL AND "provider_unit" IS NULL AND "conversion_divisor" IS NULL)
  OR (
    "provider_fuel_code" IS NOT NULL AND "provider_price" IS NOT NULL AND
    "provider_unit" IS NOT NULL AND "conversion_divisor" IS NOT NULL AND
    "provider_price" > 0 AND "price" IS NOT NULL AND "unit" = 'litre' AND
    (("provider_unit" = 'litre' AND "conversion_divisor" = 1 AND "provider_fuel_code" = "fuel_code")
      OR ("provider_unit" = '20_litres' AND "conversion_divisor" = 20 AND
        (("provider_fuel_code" = 'gasoline_95_20l' AND "fuel_code" = 'gasoline_95')
          OR ("provider_fuel_code" = 'diesel_20l' AND "fuel_code" = 'diesel')))) AND
    "price" * "conversion_divisor" = "provider_price"
  )
);
