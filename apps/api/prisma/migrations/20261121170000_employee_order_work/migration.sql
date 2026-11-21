-- Additive: existing orders retain NULL claim metadata.
BEGIN;
ALTER TABLE "orders"
  ADD COLUMN "assigned_employee_id" INTEGER,
  ADD COLUMN "claimed_at" TIMESTAMPTZ(3);

ALTER TABLE "orders" ADD CONSTRAINT "orders_assigned_employee_id_fkey"
  FOREIGN KEY ("assigned_employee_id") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "orders_assigned_employee_id_station_id_status_idx"
  ON "orders"("assigned_employee_id", "station_id", "status");

COMMIT;
