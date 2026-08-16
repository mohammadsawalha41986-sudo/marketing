-- CreateEnum
CREATE TYPE "ExternalAccountKind" AS ENUM ('BUSINESS', 'PAGE', 'INSTAGRAM', 'AD_ACCOUNT', 'CUSTOMER', 'LOCATION', 'ORGANIZATION', 'PROFILE');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "IntegrationStatus" ADD VALUE 'CONNECTING';
ALTER TYPE "IntegrationStatus" ADD VALUE 'TOKEN_EXPIRED';
ALTER TYPE "IntegrationStatus" ADD VALUE 'REAUTH_REQUIRED';

-- AlterTable
ALTER TABLE "Integration" ADD COLUMN     "accessTokenEnc" TEXT,
ADD COLUMN     "metadata" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "refreshTokenEnc" TEXT,
ADD COLUMN     "tokenExpiresAt" TIMESTAMP(3),
ADD COLUMN     "tokenFingerprint" TEXT;

-- CreateTable
CREATE TABLE "IntegrationAccount" (
    "id" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "kind" "ExternalAccountKind" NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "username" TEXT,
    "currency" TEXT,
    "timezone" TEXT,
    "parentExternalId" TEXT,
    "selected" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OAuthTransaction" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "stateHash" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "codeVerifierEnc" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationSyncRun" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "status" "SyncStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "recordsProcessed" INTEGER NOT NULL DEFAULT 0,
    "recordsCreated" INTEGER NOT NULL DEFAULT 0,
    "recordsUpdated" INTEGER NOT NULL DEFAULT 0,
    "recordsFailed" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,

    CONSTRAINT "IntegrationSyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IntegrationAccount_clientId_idx" ON "IntegrationAccount"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationAccount_integrationId_kind_externalId_key" ON "IntegrationAccount"("integrationId", "kind", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthTransaction_stateHash_key" ON "OAuthTransaction"("stateHash");

-- CreateIndex
CREATE INDEX "OAuthTransaction_clientId_platform_idx" ON "OAuthTransaction"("clientId", "platform");

-- CreateIndex
CREATE INDEX "OAuthTransaction_expiresAt_idx" ON "OAuthTransaction"("expiresAt");

-- CreateIndex
CREATE INDEX "IntegrationSyncRun_clientId_platform_idx" ON "IntegrationSyncRun"("clientId", "platform");

-- CreateIndex
CREATE INDEX "IntegrationSyncRun_integrationId_startedAt_idx" ON "IntegrationSyncRun"("integrationId", "startedAt");

-- CreateIndex
CREATE INDEX "Integration_status_idx" ON "Integration"("status");

-- AddForeignKey
ALTER TABLE "IntegrationAccount" ADD CONSTRAINT "IntegrationAccount_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationSyncRun" ADD CONSTRAINT "IntegrationSyncRun_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
