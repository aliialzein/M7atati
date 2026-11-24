-- Preserve ownership and the existing nullable manager FK. Refuse duplicates;
-- administrators must explicitly resolve them before retrying deployment.
BEGIN;
LOCK TABLE "stations" IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "stations" WHERE "manager_id" IS NOT NULL
    GROUP BY "manager_id" HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate station manager ownership exists; explicitly unassign conflicts before deployment. No assignments were changed.';
  END IF;
END $$;
CREATE UNIQUE INDEX "stations_manager_id_key" ON "stations" ("manager_id");
-- The unique index supports the same manager lookup as the old plain index.
DROP INDEX "stations_manager_id_idx";
COMMIT;
