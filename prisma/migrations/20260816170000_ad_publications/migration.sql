-- Additive: one enum and one table.

DO $$ BEGIN
  CREATE TYPE "PublicationStatus" AS ENUM ('DRAFT','APPROVED','PUBLISHING','PUBLISHED','FAILED','REQUIRES_REAUTH');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "AdPublication" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "campaignId" TEXT,
    "productId" TEXT,
    "creativeId" TEXT,
    "videoCreativeId" TEXT,
    "platform" "Platform" NOT NULL,
    "status" "PublicationStatus" NOT NULL DEFAULT 'DRAFT',
    "name" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "dailyBudget" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "countries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "linkUrl" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "headline" TEXT NOT NULL,
    "callToAction" TEXT,
    "providerCampaignId" TEXT,
    "providerAdSetId" TEXT,
    "providerCreativeId" TEXT,
    "providerAdId" TEXT,
    "providerImageHash" TEXT,
    "providerVideoId" TEXT,
    "providerAccountId" TEXT,
    "providerStatus" TEXT,
    "managerUrl" TEXT,
    "publishedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "errorStatus" INTEGER,
    "steps" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdPublication_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AdPublication_organizationId_idx" ON "AdPublication"("organizationId");
CREATE INDEX IF NOT EXISTS "AdPublication_clientId_idx" ON "AdPublication"("clientId");
CREATE INDEX IF NOT EXISTS "AdPublication_campaignId_idx" ON "AdPublication"("campaignId");
CREATE INDEX IF NOT EXISTS "AdPublication_status_idx" ON "AdPublication"("status");

ALTER TABLE "AdPublication" ADD CONSTRAINT "AdPublication_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdPublication" ADD CONSTRAINT "AdPublication_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
