-- Active orders are the authoritative pump reservations. Claiming preserves
-- the index entry; completion releases it within the order/event transaction.
-- These statements intentionally fail if legacy active orders have NULL pumps
-- or share a pump. Resolve those records explicitly before deployment; this
-- migration does not rewrite, cancel, unassign, or complete historical orders.
BEGIN;

ALTER TABLE "orders" ADD CONSTRAINT "orders_active_pump_required_check"
  CHECK ("status" NOT IN ('PENDING', 'IN_PROGRESS') OR "pump_id" IS NOT NULL);

CREATE UNIQUE INDEX "orders_active_pump_key" ON "orders" ("pump_id")
  WHERE "status" IN ('PENDING', 'IN_PROGRESS');

COMMIT;
