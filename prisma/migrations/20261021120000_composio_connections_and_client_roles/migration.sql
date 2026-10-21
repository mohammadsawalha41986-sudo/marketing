-- Additive only: one enum, one nullable column, two new tables. No existing
-- row is rewritten and nothing is dropped.

-- CreateEnum
CREATE TYPE "ClientRole" AS ENUM ('OWNER', 'MANAGER', 'MARKETING_MANAGER', 'CONTENT_CREATOR', 'FINANCIAL_ANALYST', 'VIEWER');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "clientRole" "ClientRole";

-- CreateTable
CREATE TABLE "ComposioConnection" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "toolkit" TEXT NOT NULL,
    "authConfigId" TEXT NOT NULL,
    "composioAccountId" TEXT NOT NULL,
    "remoteStatus" TEXT NOT NULL,
    "statusReason" TEXT,
    "alias" TEXT,
    "replacesId" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "verification" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "lastSuccessfulSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastErrorKind" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComposioConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderCallLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientId" TEXT,
    "provider" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL,
    "httpStatus" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderCallLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ComposioConnection_composioAccountId_key" ON "ComposioConnection"("composioAccountId");

-- CreateIndex
CREATE INDEX "ComposioConnection_organizationId_idx" ON "ComposioConnection"("organizationId");

-- CreateIndex
CREATE INDEX "ComposioConnection_clientId_toolkit_idx" ON "ComposioConnection"("clientId", "toolkit");

-- CreateIndex
CREATE INDEX "ProviderCallLog_organizationId_createdAt_idx" ON "ProviderCallLog"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "ProviderCallLog_provider_createdAt_idx" ON "ProviderCallLog"("provider", "createdAt");

-- AddForeignKey
ALTER TABLE "ComposioConnection" ADD CONSTRAINT "ComposioConnection_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComposioConnection" ADD CONSTRAINT "ComposioConnection_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderCallLog" ADD CONSTRAINT "ProviderCallLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

