-- CreateEnum
CREATE TYPE "CostCategory" AS ENUM ('ADVERTISING', 'CREATIVE', 'PHOTOGRAPHY', 'VIDEO', 'INFLUENCER', 'MANAGEMENT', 'PLATFORM_FEES', 'DISCOUNT', 'PRINTING', 'OTHER');

-- CreateEnum
CREATE TYPE "CostKind" AS ENUM ('PLANNED', 'ACTUAL');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "CampaignObjective" ADD VALUE 'REACH';
ALTER TYPE "CampaignObjective" ADD VALUE 'RESERVATIONS';
ALTER TYPE "CampaignObjective" ADD VALUE 'DELIVERY_ORDERS';
ALTER TYPE "CampaignObjective" ADD VALUE 'STORE_VISITS';
ALTER TYPE "CampaignObjective" ADD VALUE 'REVENUE';
ALTER TYPE "CampaignObjective" ADD VALUE 'PROFITABILITY';
ALTER TYPE "CampaignObjective" ADD VALUE 'NEW_CUSTOMERS';
ALTER TYPE "CampaignObjective" ADD VALUE 'REPEAT_CUSTOMERS';
ALTER TYPE "CampaignObjective" ADD VALUE 'PROMOTION';
ALTER TYPE "CampaignObjective" ADD VALUE 'PRODUCT_LAUNCH';
ALTER TYPE "CampaignObjective" ADD VALUE 'SEASONAL';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "CampaignStatus" ADD VALUE 'PLANNING';
ALTER TYPE "CampaignStatus" ADD VALUE 'READY';
ALTER TYPE "CampaignStatus" ADD VALUE 'ARCHIVED';

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "cogs" DECIMAL(14,2),
ADD COLUMN     "ctaLabel" TEXT,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "discounts" DECIMAL(14,2),
ADD COLUMN     "grossRevenue" DECIMAL(14,2),
ADD COLUMN     "landingPageUrl" TEXT,
ADD COLUMN     "language" "Language",
ADD COLUMN     "offer" TEXT,
ADD COLUMN     "products" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "secondaryObjective" "CampaignObjective",
ADD COLUMN     "strategy" TEXT,
ADD COLUMN     "targetConversions" INTEGER,
ADD COLUMN     "targetCpa" DECIMAL(12,2),
ADD COLUMN     "targetRevenue" DECIMAL(14,2),
ADD COLUMN     "targetRoas" DECIMAL(8,2);

-- CreateTable
CREATE TABLE "CampaignCost" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "kind" "CostKind" NOT NULL,
    "category" "CostCategory" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "description" TEXT,
    "incurredOn" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignCost_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CampaignCost_campaignId_kind_idx" ON "CampaignCost"("campaignId", "kind");

-- CreateIndex
CREATE INDEX "CampaignCost_organizationId_idx" ON "CampaignCost"("organizationId");

-- AddForeignKey
ALTER TABLE "CampaignCost" ADD CONSTRAINT "CampaignCost_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
