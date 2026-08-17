-- CreateEnum
CREATE TYPE "PerformanceGrain" AS ENUM ('ACCOUNT', 'CAMPAIGN', 'AD_SET', 'AD');

-- CreateTable
CREATE TABLE "CreativePerformance" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "date" DATE NOT NULL,
    "creativeId" TEXT,
    "videoCreativeId" TEXT,
    "campaignId" TEXT,
    "publicationId" TEXT,
    "providerAccountId" TEXT,
    "providerCampaignId" TEXT,
    "providerAdSetId" TEXT,
    "providerAdId" TEXT,
    "grain" "PerformanceGrain" NOT NULL DEFAULT 'AD',
    "spend" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "reach" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "linkClicks" INTEGER NOT NULL DEFAULT 0,
    "conversions" INTEGER NOT NULL DEFAULT 0,
    "revenue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "engagements" INTEGER NOT NULL DEFAULT 0,
    "videoViews" INTEGER,
    "videoThruplays" INTEGER,
    "videoCompletions" INTEGER,
    "frequency" DOUBLE PRECISION,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreativePerformance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignCreative" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "creativeId" TEXT NOT NULL,
    "providerAdId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "role" TEXT NOT NULL DEFAULT 'PRIMARY',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignCreative_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CreativePerformance_organizationId_date_idx" ON "CreativePerformance"("organizationId", "date");

-- CreateIndex
CREATE INDEX "CreativePerformance_clientId_date_idx" ON "CreativePerformance"("clientId", "date");

-- CreateIndex
CREATE INDEX "CreativePerformance_creativeId_date_idx" ON "CreativePerformance"("creativeId", "date");

-- CreateIndex
CREATE INDEX "CreativePerformance_campaignId_date_idx" ON "CreativePerformance"("campaignId", "date");

-- CreateIndex
CREATE INDEX "CreativePerformance_publicationId_idx" ON "CreativePerformance"("publicationId");

-- CreateIndex
CREATE UNIQUE INDEX "CreativePerformance_providerAdId_date_grain_key" ON "CreativePerformance"("providerAdId", "date", "grain");

-- CreateIndex
CREATE INDEX "CampaignCreative_organizationId_idx" ON "CampaignCreative"("organizationId");

-- CreateIndex
CREATE INDEX "CampaignCreative_creativeId_idx" ON "CampaignCreative"("creativeId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignCreative_campaignId_creativeId_key" ON "CampaignCreative"("campaignId", "creativeId");

-- AddForeignKey
ALTER TABLE "CreativePerformance" ADD CONSTRAINT "CreativePerformance_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativePerformance" ADD CONSTRAINT "CreativePerformance_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativePerformance" ADD CONSTRAINT "CreativePerformance_creativeId_fkey" FOREIGN KEY ("creativeId") REFERENCES "Creative"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignCreative" ADD CONSTRAINT "CampaignCreative_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignCreative" ADD CONSTRAINT "CampaignCreative_creativeId_fkey" FOREIGN KEY ("creativeId") REFERENCES "Creative"("id") ON DELETE CASCADE ON UPDATE CASCADE;
