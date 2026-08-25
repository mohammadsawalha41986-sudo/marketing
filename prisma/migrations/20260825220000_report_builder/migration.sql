-- AlterEnum
-- Additive only: one new ReportType for saved Report Builder configurations.
-- No existing row changes type, and no column is added or dropped.
ALTER TYPE "ReportType" ADD VALUE 'BUILDER';
