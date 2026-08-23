-- AlterTable
ALTER TABLE "IntegrationAccount" ADD COLUMN     "grantedScopes" TEXT[] DEFAULT ARRAY[]::TEXT[];
