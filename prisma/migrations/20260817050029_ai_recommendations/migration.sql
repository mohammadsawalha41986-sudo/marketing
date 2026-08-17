-- CreateEnum
CREATE TYPE "RecommendationType" AS ENUM ('INCREASE_BUDGET', 'DECREASE_BUDGET', 'PAUSE_CREATIVE', 'PAUSE_AD', 'PAUSE_ADSET', 'CHANGE_SCHEDULE', 'REVIEW_AUDIENCE', 'REVIEW_LANDING_PAGE', 'REVIEW_TRACKING', 'ADD_CREATIVE_VARIANT', 'REDUCE_SPEND', 'REAUTHORIZE_ACCOUNT', 'NO_ACTION');

-- CreateEnum
CREATE TYPE "RecommendationConfidence" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "RecommendationStatus" AS ENUM ('PENDING', 'APPROVED', 'APPLIED', 'REJECTED', 'EXPIRED', 'FAILED');

-- CreateTable
CREATE TABLE "AiRecommendation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "campaignId" TEXT,
    "creativeId" TEXT,
    "publicationId" TEXT,
    "type" "RecommendationType" NOT NULL,
    "state" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "confidence" "RecommendationConfidence" NOT NULL DEFAULT 'MEDIUM',
    "proposedChange" JSONB,
    "expectedImpact" TEXT,
    "metricsSnapshot" JSONB NOT NULL DEFAULT '{}',
    "windowFrom" TIMESTAMP(3),
    "windowTo" TIMESTAMP(3),
    "status" "RecommendationStatus" NOT NULL DEFAULT 'PENDING',
    "appliedAt" TIMESTAMP(3),
    "appliedById" TEXT,
    "providerResult" JSONB,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiRecommendation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationSettings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientId" TEXT,
    "autoOptimizationEnabled" BOOLEAN NOT NULL DEFAULT false,
    "requireApprovalForBudget" BOOLEAN NOT NULL DEFAULT true,
    "requireApprovalForPauses" BOOLEAN NOT NULL DEFAULT true,
    "maxBudgetIncreasePercent" INTEGER NOT NULL DEFAULT 20,
    "maxBudgetDecreasePercent" INTEGER NOT NULL DEFAULT 30,
    "maxDailyBudget" DECIMAL(12,2),
    "minDailyBudget" DECIMAL(12,2),
    "allowedActions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiRecommendation_organizationId_status_idx" ON "AiRecommendation"("organizationId", "status");

-- CreateIndex
CREATE INDEX "AiRecommendation_clientId_createdAt_idx" ON "AiRecommendation"("clientId", "createdAt");

-- CreateIndex
CREATE INDEX "AiRecommendation_campaignId_idx" ON "AiRecommendation"("campaignId");

-- CreateIndex
CREATE INDEX "AiRecommendation_creativeId_idx" ON "AiRecommendation"("creativeId");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationSettings_clientId_key" ON "AutomationSettings"("clientId");

-- CreateIndex
CREATE INDEX "AutomationSettings_organizationId_idx" ON "AutomationSettings"("organizationId");

-- AddForeignKey
ALTER TABLE "AiRecommendation" ADD CONSTRAINT "AiRecommendation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiRecommendation" ADD CONSTRAINT "AiRecommendation_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationSettings" ADD CONSTRAINT "AutomationSettings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
