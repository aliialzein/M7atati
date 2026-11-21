BEGIN;

-- Block concurrent attendance writes while checking and establishing invariants.
LOCK TABLE "attendance_records" IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "attendance_records" WHERE "clock_out_at" IS NULL
    GROUP BY "employee_id" HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate open attendance records exist; review the read-only preflight. No records were changed.';
  END IF;
END $$;

ALTER TABLE "attendance_records" ADD COLUMN "check_in_request_id" UUID;
CREATE UNIQUE INDEX "attendance_employee_request_key"
  ON "attendance_records" ("employee_id", "check_in_request_id");
CREATE UNIQUE INDEX "attendance_one_open_per_employee"
  ON "attendance_records" ("employee_id") WHERE "clock_out_at" IS NULL;

COMMIT;
