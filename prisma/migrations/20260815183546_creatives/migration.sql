-- CreateEnum
CREATE TYPE "CreativeFormat" AS ENUM ('PNG', 'JPG');

-- CreateEnum
CREATE TYPE "CreativeStatus" AS ENUM ('DRAFT', 'SAVED', 'APPROVED');

-- CreateTable
CREATE TABLE "Creative" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "contentId" TEXT,
    "campaignId" TEXT,
    "sourceMediaId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "preset" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "format" "CreativeFormat" NOT NULL DEFAULT 'PNG',
    "storageKey" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "headline" TEXT,
    "ctaLabel" TEXT,
    "match" JSONB NOT NULL DEFAULT '{}',
    "status" "CreativeStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Creative_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Creative_organizationId_idx" ON "Creative"("organizationId");

-- CreateIndex
CREATE INDEX "Creative_clientId_idx" ON "Creative"("clientId");

-- CreateIndex
CREATE INDEX "Creative_contentId_idx" ON "Creative"("contentId");

-- CreateIndex
CREATE INDEX "Creative_sourceMediaId_idx" ON "Creative"("sourceMediaId");

-- AddForeignKey
ALTER TABLE "Creative" ADD CONSTRAINT "Creative_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Creative" ADD CONSTRAINT "Creative_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "Content"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Creative" ADD CONSTRAINT "Creative_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Creative" ADD CONSTRAINT "Creative_sourceMediaId_fkey" FOREIGN KEY ("sourceMediaId") REFERENCES "Media"("id") ON DELETE CASCADE ON UPDATE CASCADE;
