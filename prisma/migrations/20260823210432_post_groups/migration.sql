-- CreateEnum
CREATE TYPE "PostGroupStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'CHANGES_REQUESTED', 'APPROVED', 'SCHEDULED', 'PUBLISHING', 'PARTIALLY_PUBLISHED', 'PUBLISHED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PlatformPostStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'CHANGES_REQUESTED', 'APPROVED', 'SCHEDULED', 'QUEUED', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "Platform" ADD VALUE 'YOUTUBE';

-- CreateTable
CREATE TABLE "PostGroup" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "campaignId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "PostGroupStatus" NOT NULL DEFAULT 'DRAFT',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PostGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformPost" (
    "id" TEXT NOT NULL,
    "postGroupId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "integrationAccountId" TEXT,
    "caption" TEXT,
    "headline" TEXT,
    "hashtags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "linkUrl" TEXT,
    "ctaLabel" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "status" "PlatformPostStatus" NOT NULL DEFAULT 'DRAFT',
    "scheduledAt" TIMESTAMP(3),
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Riyadh',
    "externalPostId" TEXT,
    "externalUrl" TEXT,
    "publishedAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "nextRetryAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformPostMedia" (
    "id" TEXT NOT NULL,
    "platformPostId" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "role" TEXT,

    CONSTRAINT "PlatformPostMedia_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PostGroup_organizationId_idx" ON "PostGroup"("organizationId");

-- CreateIndex
CREATE INDEX "PostGroup_clientId_idx" ON "PostGroup"("clientId");

-- CreateIndex
CREATE INDEX "PostGroup_campaignId_idx" ON "PostGroup"("campaignId");

-- CreateIndex
CREATE INDEX "PostGroup_status_idx" ON "PostGroup"("status");

-- CreateIndex
CREATE INDEX "PlatformPost_status_idx" ON "PlatformPost"("status");

-- CreateIndex
CREATE INDEX "PlatformPost_scheduledAt_idx" ON "PlatformPost"("scheduledAt");

-- CreateIndex
CREATE INDEX "PlatformPost_nextRetryAt_idx" ON "PlatformPost"("nextRetryAt");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformPost_postGroupId_platform_key" ON "PlatformPost"("postGroupId", "platform");

-- CreateIndex
CREATE INDEX "PlatformPostMedia_platformPostId_idx" ON "PlatformPostMedia"("platformPostId");

-- CreateIndex
CREATE INDEX "PlatformPostMedia_mediaId_idx" ON "PlatformPostMedia"("mediaId");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformPostMedia_platformPostId_mediaId_role_key" ON "PlatformPostMedia"("platformPostId", "mediaId", "role");

-- AddForeignKey
ALTER TABLE "PostGroup" ADD CONSTRAINT "PostGroup_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostGroup" ADD CONSTRAINT "PostGroup_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostGroup" ADD CONSTRAINT "PostGroup_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostGroup" ADD CONSTRAINT "PostGroup_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformPost" ADD CONSTRAINT "PlatformPost_postGroupId_fkey" FOREIGN KEY ("postGroupId") REFERENCES "PostGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformPost" ADD CONSTRAINT "PlatformPost_integrationAccountId_fkey" FOREIGN KEY ("integrationAccountId") REFERENCES "IntegrationAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformPostMedia" ADD CONSTRAINT "PlatformPostMedia_platformPostId_fkey" FOREIGN KEY ("platformPostId") REFERENCES "PlatformPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformPostMedia" ADD CONSTRAINT "PlatformPostMedia_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "Media"("id") ON DELETE CASCADE ON UPDATE CASCADE;
