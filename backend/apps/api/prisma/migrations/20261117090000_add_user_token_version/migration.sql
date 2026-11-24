-- Existing accounts retain their IDs and data. JWTs without a version claim
-- are rejected by the application; existing accounts must log in again.
ALTER TABLE "users" ADD COLUMN "token_version" INTEGER NOT NULL DEFAULT 0;
