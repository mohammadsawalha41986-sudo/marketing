-- CreateEnum
CREATE TYPE "ReviewSentiment" AS ENUM ('POSITIVE', 'NEUTRAL', 'NEGATIVE');

-- CreateEnum
CREATE TYPE "ReviewCategory" AS ENUM ('PRAISE', 'COMPLAINT', 'QUESTION', 'SERVICE', 'PRODUCT', 'STAFF', 'PRICING', 'LOCATION', 'OTHER');

-- CreateEnum
CREATE TYPE "ReviewReplyStatus" AS ENUM ('NONE', 'SUGGESTED', 'PENDING_APPROVAL', 'PUBLISHED', 'FAILED');

-- CreateTable
CREATE TABLE "GoogleLocation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "externalName" TEXT NOT NULL,
    "accountName" TEXT,
    "title" TEXT NOT NULL,
    "storeCode" TEXT,
    "addressLines" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "locality" TEXT,
    "region" TEXT,
    "postalCode" TEXT,
    "country" TEXT,
    "phone" TEXT,
    "websiteUri" TEXT,
    "mapsUri" TEXT,
    "primaryCategory" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "syncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoogleLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoogleReview" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "reviewerName" TEXT,
    "reviewerPhotoUrl" TEXT,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "createTime" TIMESTAMP(3) NOT NULL,
    "updateTime" TIMESTAMP(3),
    "sentiment" "ReviewSentiment",
    "category" "ReviewCategory",
    "complaintKey" TEXT,
    "analyzedAt" TIMESTAMP(3),
    "aiSuggestion" TEXT,
    "aiProvider" TEXT,
    "aiGeneratedAt" TIMESTAMP(3),
    "replyStatus" "ReviewReplyStatus" NOT NULL DEFAULT 'NONE',
    "replyText" TEXT,
    "replyApprovedById" TEXT,
    "repliedAt" TIMESTAMP(3),
    "replyError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoogleReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GoogleLocation_organizationId_idx" ON "GoogleLocation"("organizationId");

-- CreateIndex
CREATE INDEX "GoogleLocation_clientId_idx" ON "GoogleLocation"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "GoogleLocation_integrationId_externalName_key" ON "GoogleLocation"("integrationId", "externalName");

-- CreateIndex
CREATE INDEX "GoogleReview_organizationId_idx" ON "GoogleReview"("organizationId");

-- CreateIndex
CREATE INDEX "GoogleReview_clientId_idx" ON "GoogleReview"("clientId");

-- CreateIndex
CREATE INDEX "GoogleReview_sentiment_idx" ON "GoogleReview"("sentiment");

-- CreateIndex
CREATE INDEX "GoogleReview_replyStatus_idx" ON "GoogleReview"("replyStatus");

-- CreateIndex
CREATE INDEX "GoogleReview_createTime_idx" ON "GoogleReview"("createTime");

-- CreateIndex
CREATE UNIQUE INDEX "GoogleReview_locationId_externalId_key" ON "GoogleReview"("locationId", "externalId");

-- AddForeignKey
ALTER TABLE "GoogleLocation" ADD CONSTRAINT "GoogleLocation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleLocation" ADD CONSTRAINT "GoogleLocation_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleLocation" ADD CONSTRAINT "GoogleLocation_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleReview" ADD CONSTRAINT "GoogleReview_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleReview" ADD CONSTRAINT "GoogleReview_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleReview" ADD CONSTRAINT "GoogleReview_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "GoogleLocation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleReview" ADD CONSTRAINT "GoogleReview_replyApprovedById_fkey" FOREIGN KEY ("replyApprovedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
