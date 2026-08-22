-- CreateEnum
CREATE TYPE "CreativeSource" AS ENUM ('UPLOADED', 'RENDERED', 'GENERATED');

-- AlterTable
ALTER TABLE "Creative" ADD COLUMN     "mediaId" TEXT,
ADD COLUMN     "source" "CreativeSource" NOT NULL DEFAULT 'RENDERED',
ALTER COLUMN "sourceMediaId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Media" ADD COLUMN     "audioCodec" TEXT,
ADD COLUMN     "bitrateKbps" INTEGER,
ADD COLUMN     "durationSeconds" DOUBLE PRECISION,
ADD COLUMN     "frameRate" DOUBLE PRECISION,
ADD COLUMN     "hasAudio" BOOLEAN,
ADD COLUMN     "sha256" TEXT,
ADD COLUMN     "videoCodec" TEXT;

-- CreateIndex
CREATE INDEX "Creative_mediaId_idx" ON "Creative"("mediaId");

-- CreateIndex
CREATE INDEX "Creative_source_idx" ON "Creative"("source");

-- CreateIndex
CREATE INDEX "Media_organizationId_sha256_idx" ON "Media"("organizationId", "sha256");

-- AddForeignKey
ALTER TABLE "Creative" ADD CONSTRAINT "Creative_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "Media"("id") ON DELETE CASCADE ON UPDATE CASCADE;
