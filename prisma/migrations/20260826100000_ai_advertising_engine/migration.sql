-- AI Advertising Engine.
--
-- Additive only. The existing AiRecommendation model already carries the
-- evidence, confidence, proposed change and window that a recommendation needs;
-- what it could not express was how urgent one is, which services were actually
-- queried to produce it, and which platform or place it concerns.
--
-- Enum values are appended rather than inserted: PostgreSQL orders enum values
-- by definition order and existing rows hold the earlier ones.

CREATE TYPE "RecommendationPriority" AS ENUM ('P0', 'P1', 'P2', 'P3');

ALTER TABLE "AiRecommendation"
  ADD COLUMN "priority" "RecommendationPriority" NOT NULL DEFAULT 'P2',
  ADD COLUMN "dataSources" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "platform" "Platform",
  ADD COLUMN "location" TEXT;

ALTER TYPE "RecommendationType" ADD VALUE 'BEST_PLATFORM';
ALTER TYPE "RecommendationType" ADD VALUE 'BEST_CAMPAIGN';
ALTER TYPE "RecommendationType" ADD VALUE 'BEST_TIME';
ALTER TYPE "RecommendationType" ADD VALUE 'LOCATION_OPPORTUNITY';
ALTER TYPE "RecommendationType" ADD VALUE 'WINNING_CREATIVE';
ALTER TYPE "RecommendationType" ADD VALUE 'CREATIVE_FATIGUE';
ALTER TYPE "RecommendationType" ADD VALUE 'ORGANIC_TO_PAID';
ALTER TYPE "RecommendationType" ADD VALUE 'PAID_TO_ORGANIC';
ALTER TYPE "RecommendationType" ADD VALUE 'PERFORMANCE_ANOMALY';
ALTER TYPE "RecommendationType" ADD VALUE 'DATA_QUALITY';
ALTER TYPE "RecommendationType" ADD VALUE 'REVIEW_COPY';
ALTER TYPE "RecommendationType" ADD VALUE 'REVIEW_CTA';
ALTER TYPE "RecommendationType" ADD VALUE 'REVIEW_HASHTAGS';
ALTER TYPE "RecommendationType" ADD VALUE 'REALLOCATE_BUDGET';

ALTER TYPE "RecommendationStatus" ADD VALUE 'REVIEWED';

CREATE INDEX "AiRecommendation_organizationId_priority_idx"
  ON "AiRecommendation" ("organizationId", "priority");
