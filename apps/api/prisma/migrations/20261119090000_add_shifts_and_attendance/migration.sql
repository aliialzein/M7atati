-- Additive only: existing identities and assignments are unchanged. No backfill.
CREATE TABLE "shifts" (
    "id" SERIAL NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "station_id" INTEGER NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "shifts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "shifts_time_order" CHECK ("ends_at" > "starts_at"),
    CONSTRAINT "shifts_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "shifts_station_id_fkey" FOREIGN KEY ("station_id") REFERENCES "stations"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "attendance_records" (
    "id" SERIAL NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "station_id" INTEGER NOT NULL,
    "clock_in_at" TIMESTAMPTZ(3) NOT NULL,
    "clock_out_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "attendance_records_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "attendance_records_time_order" CHECK ("clock_out_at" IS NULL OR "clock_out_at" >= "clock_in_at"),
    CONSTRAINT "attendance_records_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "attendance_records_station_id_fkey" FOREIGN KEY ("station_id") REFERENCES "stations"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "shifts_starts_at_id_idx" ON "shifts"("starts_at", "id");
CREATE INDEX "shifts_station_id_starts_at_idx" ON "shifts"("station_id", "starts_at");
CREATE INDEX "shifts_employee_id_starts_at_idx" ON "shifts"("employee_id", "starts_at");
CREATE INDEX "attendance_records_clock_in_at_id_idx" ON "attendance_records"("clock_in_at", "id");
CREATE INDEX "attendance_records_station_id_clock_in_at_idx" ON "attendance_records"("station_id", "clock_in_at");
CREATE INDEX "attendance_records_employee_id_clock_in_at_idx" ON "attendance_records"("employee_id", "clock_in_at");
