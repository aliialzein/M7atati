-- Additive: legacy payments retain NULL confirmation metadata.
ALTER TABLE "payments" ADD COLUMN "confirmed_by_id" INTEGER,
                       ADD COLUMN "confirmed_at" TIMESTAMPTZ(3);
ALTER TABLE "payments" ADD CONSTRAINT "payments_confirmed_by_id_fkey"
  FOREIGN KEY ("confirmed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "payments_confirmed_by_id_idx" ON "payments"("confirmed_by_id");
-- Only newly confirmed cash records participate; do not rewrite legacy attempts.
CREATE UNIQUE INDEX "payments_confirmed_cash_order_key" ON "payments"("order_id")
  WHERE "method" = 'CASH' AND "confirmed_at" IS NOT NULL;
ALTER TABLE "payments" ADD CONSTRAINT "payments_cash_confirmation_check" CHECK (
  ("confirmed_at" IS NULL AND "confirmed_by_id" IS NULL) OR
  ("confirmed_at" IS NOT NULL AND "confirmed_by_id" IS NOT NULL AND
   "method" = 'CASH' AND "status" = 'CONFIRMED' AND "currency" IN ('USD', 'LBP') AND
   "amount_minor" > 0 AND "captured_minor" = "amount_minor")
);
