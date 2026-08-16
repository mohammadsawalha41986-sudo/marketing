-- Additive: one enum and one table. Nothing existing is altered or removed.

DO $$ BEGIN
  CREATE TYPE "AudioSource" AS ENUM ('NONE', 'UPLOAD', 'LIBRARY');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "VideoCreative" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "productId" TEXT,
    "campaignId" TEXT,
    "contentId" TEXT,
    "sourceMediaId" TEXT,
    "platform" "Platform" NOT NULL,
    "placement" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "durationSeconds" DOUBLE PRECISION NOT NULL,
    "storageKey" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "videoCodec" TEXT,
    "audioCodec" TEXT,
    "frameRate" DOUBLE PRECISION,
    "audioSource" "AudioSource" NOT NULL DEFAULT 'NONE',
    "audioMediaId" TEXT,
    "script" JSONB NOT NULL,
    "compositions" JSONB,
    "status" "CreativeStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VideoCreative_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "VideoCreative_organizationId_idx" ON "VideoCreative"("organizationId");
CREATE INDEX IF NOT EXISTS "VideoCreative_clientId_idx" ON "VideoCreative"("clientId");
CREATE INDEX IF NOT EXISTS "VideoCreative_productId_idx" ON "VideoCreative"("productId");
CREATE INDEX IF NOT EXISTS "VideoCreative_campaignId_idx" ON "VideoCreative"("campaignId");

ALTER TABLE "VideoCreative" ADD CONSTRAINT "VideoCreative_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VideoCreative" ADD CONSTRAINT "VideoCreative_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
