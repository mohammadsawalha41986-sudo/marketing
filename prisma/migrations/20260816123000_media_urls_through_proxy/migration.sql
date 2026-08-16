-- Point existing media URLs at the authenticated proxy routes.
--
-- Rows written before this change hold whatever the storage driver returned:
-- a `/uploads/<key>` path that only resolves on a container that still has the
-- file. Those URLs are rewritten to `/api/media/<id>/file`, which resolves
-- through the storage layer whichever driver is mounted.
--
-- This updates two columns on existing rows. Nothing is dropped, truncated or
-- deleted, and `filename` — the storage key, which is the part that cannot be
-- reconstructed — is not touched.

UPDATE "Media"
   SET "url" = '/api/media/' || "id" || '/file'
 WHERE "url" NOT LIKE '/api/media/%';

UPDATE "Media"
   SET "thumbnailUrl" = '/api/media/' || "id" || '/file'
 WHERE "thumbnailUrl" IS NOT NULL
   AND "thumbnailUrl" NOT LIKE '/api/media/%';

-- Brand and client logos move to their own route, which reads the brand's
-- storage key rather than a path.
UPDATE "Brand"
   SET "logoUrl" = '/api/brands/' || "clientId" || '/logo'
 WHERE "logoUrl" IS NOT NULL
   AND "logoUrl" NOT LIKE '/api/brands/%';

UPDATE "Client" c
   SET "logoUrl" = '/api/brands/' || c."id" || '/logo'
  FROM "Brand" b
 WHERE b."clientId" = c."id"
   AND c."logoUrl" IS NOT NULL
   AND c."logoUrl" NOT LIKE '/api/brands/%';

UPDATE "BrandAsset" a
   SET "url" = '/api/brands/' || b."clientId" || '/logo'
  FROM "Brand" b
 WHERE b."id" = a."brandId"
   AND a."kind" = 'LOGO'
   AND a."url" NOT LIKE '/api/brands/%';
