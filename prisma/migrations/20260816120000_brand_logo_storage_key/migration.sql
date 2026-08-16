-- Additive only: one nullable column, plus a backfill that reads existing data.
-- Nothing is dropped, truncated or reset.

ALTER TABLE "Brand" ADD COLUMN IF NOT EXISTS "logoKey" TEXT;

-- Existing logos were stored by the local driver and recorded as `/uploads/<key>`.
-- The key is what the storage layer needs; derive it where the shape is known and
-- leave it NULL otherwise rather than guessing.
UPDATE "Brand"
   SET "logoKey" = substring("logoUrl" from 10)
 WHERE "logoKey" IS NULL
   AND "logoUrl" LIKE '/uploads/%';
