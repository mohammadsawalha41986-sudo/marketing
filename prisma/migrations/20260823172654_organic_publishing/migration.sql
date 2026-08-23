-- CreateEnum
CREATE TYPE "AccountTokenStatus" AS ENUM ('UNKNOWN', 'TOKEN_VALID', 'TOKEN_EXPIRED', 'REAUTH_REQUIRED', 'MISSING_PERMISSION');

-- CreateEnum
CREATE TYPE "PublishingJobStatus" AS ENUM ('QUEUED', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PublishingAttemptResult" AS ENUM ('SUCCESS', 'RETRYABLE_FAILURE', 'PERMANENT_FAILURE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ContentStatus" ADD VALUE 'QUEUED';
ALTER TYPE "ContentStatus" ADD VALUE 'PUBLISHING';
ALTER TYPE "ContentStatus" ADD VALUE 'PUBLISH_FAILED';
ALTER TYPE "ContentStatus" ADD VALUE 'CANCELLED';

-- AlterTable
ALTER TABLE "IntegrationAccount" ADD COLUMN     "accessTokenEnc" TEXT,
ADD COLUMN     "tokenCheckedAt" TIMESTAMP(3),
ADD COLUMN     "tokenExpiresAt" TIMESTAMP(3),
ADD COLUMN     "tokenStatus" "AccountTokenStatus" NOT NULL DEFAULT 'REAUTH_REQUIRED';

-- CreateTable
CREATE TABLE "PublishingJob" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "accountId" TEXT,
    "platform" "Platform" NOT NULL,
    "status" "PublishingJobStatus" NOT NULL DEFAULT 'QUEUED',
    "scheduledAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "externalPostId" TEXT,
    "permalink" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "failedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PublishingJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublishingAttempt" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "result" "PublishingAttemptResult" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "externalPostId" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "httpStatus" INTEGER,

    CONSTRAINT "PublishingAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PublishingJob_organizationId_idx" ON "PublishingJob"("organizationId");

-- CreateIndex
CREATE INDEX "PublishingJob_clientId_idx" ON "PublishingJob"("clientId");

-- CreateIndex
CREATE INDEX "PublishingJob_status_idx" ON "PublishingJob"("status");

-- CreateIndex
CREATE INDEX "PublishingJob_nextAttemptAt_idx" ON "PublishingJob"("nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "PublishingJob_contentId_platform_key" ON "PublishingJob"("contentId", "platform");

-- CreateIndex
CREATE INDEX "PublishingAttempt_jobId_idx" ON "PublishingAttempt"("jobId");

-- AddForeignKey
ALTER TABLE "PublishingJob" ADD CONSTRAINT "PublishingJob_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "Content"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishingJob" ADD CONSTRAINT "PublishingJob_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "IntegrationAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishingAttempt" ADD CONSTRAINT "PublishingAttempt_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "PublishingJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
