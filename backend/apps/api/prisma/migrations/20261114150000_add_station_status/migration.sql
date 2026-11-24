-- Preserve existing stations as active; new stations default to active.
ALTER TABLE "stations" ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT true;
