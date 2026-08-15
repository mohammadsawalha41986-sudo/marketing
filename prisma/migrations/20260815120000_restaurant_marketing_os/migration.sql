-- Convert the multi-tenant SaaS schema into the single-operator Restaurant
-- Marketing OS.
--
-- WRITTEN BY HAND, not generated. `prisma migrate diff` produces a correct-
-- looking script for this change that DROPs "Client" and drops/re-adds every
-- "clientId" column, which would destroy every restaurant, campaign, content
-- item and analytics row in the database. Everything below is expressed as
-- RENAME wherever data is involved, so existing rows survive.
--
-- The two deliberately destructive steps, and why:
--
--   1. "organizationId" is dropped from every table and "Organization" is
--      dropped. The product now has exactly one operator and one workspace, so
--      the tenancy column has no meaning. Rows are NOT deleted — they are all
--      adopted by the single workspace. On a database that genuinely held more
--      than one agency this would merge them, which is why it is called out
--      here rather than buried.
--
--   2. Client-portal user accounts (CLIENT_ADMIN / CLIENT_USER) are deleted.
--      Restaurants are service clients, not application users; leaving these
--      rows would leave working logins for a portal that no longer exists.
--      This is a security requirement, not a cleanup.
--
-- Everything else — plans, subscriptions, approvals, comments, reset tokens —
-- is dropped because the feature itself is gone.

-- ---------------------------------------------------------------- 1. purge portal accounts

-- Sessions cascade from User, so these logins die with the accounts.
DELETE FROM "User" WHERE "role" IN ('CLIENT_ADMIN', 'CLIENT_USER');

-- Notifications that describe the approval workflow reference states that no
-- longer exist in the enum. They are history for a removed feature.
DELETE FROM "Notification"
WHERE "type" IN ('APPROVAL_REQUESTED', 'CONTENT_APPROVED', 'CONTENT_REJECTED', 'CHANGES_REQUESTED');

-- ---------------------------------------------------------------- 2. drop removed features

DROP TABLE IF EXISTS "Subscription";
DROP TABLE IF EXISTS "Plan";
DROP TABLE IF EXISTS "Approval";
DROP TABLE IF EXISTS "Comment";
DROP TABLE IF EXISTS "PasswordResetToken";
DROP TYPE IF EXISTS "SubscriptionStatus";
DROP TYPE IF EXISTS "ApprovalStatus";

-- ---------------------------------------------------------------- 3. enums

-- Role: every surviving account is the operator.
ALTER TABLE "User" ALTER COLUMN "role" DROP DEFAULT;
CREATE TYPE "Role_new" AS ENUM ('OWNER');
ALTER TABLE "User" ALTER COLUMN "role" TYPE "Role_new" USING ('OWNER'::"Role_new");
DROP TYPE "Role";
ALTER TYPE "Role_new" RENAME TO "Role";
ALTER TABLE "User" ALTER COLUMN "role" SET DEFAULT 'OWNER';

-- ClientStatus -> RestaurantStatus. SUSPENDED was a billing state; a restaurant
-- the operator has stopped working on is simply PAUSED.
ALTER TABLE "Client" ALTER COLUMN "status" DROP DEFAULT;
CREATE TYPE "RestaurantStatus" AS ENUM ('ACTIVE', 'PAUSED', 'ARCHIVED');
ALTER TABLE "Client" ALTER COLUMN "status" TYPE "RestaurantStatus" USING (
  CASE "status"::text
    WHEN 'SUSPENDED' THEN 'PAUSED'
    ELSE "status"::text
  END::"RestaurantStatus"
);
DROP TYPE "ClientStatus";
ALTER TABLE "Client" ALTER COLUMN "status" SET DEFAULT 'ACTIVE';

-- CampaignStatus: the lifecycle is now planning -> active -> completed.
ALTER TABLE "Campaign" ALTER COLUMN "status" DROP DEFAULT;
CREATE TYPE "CampaignStatus_new" AS ENUM ('PLANNING', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED');
ALTER TABLE "Campaign" ALTER COLUMN "status" TYPE "CampaignStatus_new" USING (
  CASE "status"::text
    WHEN 'DRAFT'     THEN 'PLANNING'
    WHEN 'SCHEDULED' THEN 'PLANNING'
    WHEN 'RUNNING'   THEN 'ACTIVE'
    WHEN 'CANCELLED' THEN 'ARCHIVED'
    ELSE "status"::text
  END::"CampaignStatus_new"
);
DROP TYPE "CampaignStatus";
ALTER TYPE "CampaignStatus_new" RENAME TO "CampaignStatus";
ALTER TABLE "Campaign" ALTER COLUMN "status" SET DEFAULT 'PLANNING';

-- ContentStatus: the approval states collapse into the operator's own pipeline.
-- Anything that was approved or awaiting approval is work that is READY to go
-- out; anything rejected or failed goes back to DRAFT for another pass.
ALTER TABLE "Content" ALTER COLUMN "status" DROP DEFAULT;
CREATE TYPE "ContentStatus_new" AS ENUM ('IDEA', 'DRAFT', 'READY', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED');
ALTER TABLE "Content" ALTER COLUMN "status" TYPE "ContentStatus_new" USING (
  CASE "status"::text
    WHEN 'SUBMITTED'         THEN 'READY'
    WHEN 'APPROVED'          THEN 'READY'
    WHEN 'REJECTED'          THEN 'DRAFT'
    WHEN 'CHANGES_REQUESTED' THEN 'DRAFT'
    WHEN 'FAILED'            THEN 'DRAFT'
    ELSE "status"::text
  END::"ContentStatus_new"
);
DROP TYPE "ContentStatus";
ALTER TYPE "ContentStatus_new" RENAME TO "ContentStatus";
ALTER TABLE "Content" ALTER COLUMN "status" SET DEFAULT 'IDEA';

-- ContentType: AD is now AD_CREATIVE, to distinguish the artwork from the Ad row.
ALTER TABLE "Content" ALTER COLUMN "type" DROP DEFAULT;
CREATE TYPE "ContentType_new" AS ENUM ('POST', 'STORY', 'REEL', 'CAROUSEL', 'AD_CREATIVE', 'VIDEO', 'ARTICLE', 'EMAIL');
ALTER TABLE "Content" ALTER COLUMN "type" TYPE "ContentType_new" USING (
  CASE "type"::text
    WHEN 'AD' THEN 'AD_CREATIVE'
    ELSE "type"::text
  END::"ContentType_new"
);
DROP TYPE "ContentType";
ALTER TYPE "ContentType_new" RENAME TO "ContentType";
ALTER TABLE "Content" ALTER COLUMN "type" SET DEFAULT 'POST';

-- NotificationType: approval events are gone (their rows were deleted above),
-- content scheduling and task reminders take their place.
CREATE TYPE "NotificationType_new" AS ENUM (
  'CAMPAIGN_CREATED', 'CAMPAIGN_ENDING', 'BUDGET_WARNING', 'CONTENT_SCHEDULED',
  'CONTENT_PUBLISHED', 'PUBLISH_FAILED', 'TASK_DUE', 'INTEGRATION_DISCONNECTED',
  'REPORT_READY', 'AI_ALERT'
);
ALTER TABLE "Notification" ALTER COLUMN "type" TYPE "NotificationType_new"
  USING ("type"::text::"NotificationType_new");
DROP TYPE "NotificationType";
ALTER TYPE "NotificationType_new" RENAME TO "NotificationType";

-- ReportType: a client report is a restaurant report.
ALTER TABLE "Report" ALTER COLUMN "type" DROP DEFAULT;
CREATE TYPE "ReportType_new" AS ENUM ('RESTAURANT', 'CAMPAIGN', 'MONTHLY', 'PLATFORM');
ALTER TABLE "Report" ALTER COLUMN "type" TYPE "ReportType_new" USING (
  CASE "type"::text
    WHEN 'CLIENT' THEN 'RESTAURANT'
    ELSE "type"::text
  END::"ReportType_new"
);
DROP TYPE "ReportType";
ALTER TYPE "ReportType_new" RENAME TO "ReportType";
ALTER TABLE "Report" ALTER COLUMN "type" SET DEFAULT 'RESTAURANT';

CREATE TYPE "AdStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED');
CREATE TYPE "TaskStatus" AS ENUM ('TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE');
CREATE TYPE "TaskPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- ---------------------------------------------------------------- 4. Client -> Restaurant

ALTER TABLE "Client" RENAME TO "Restaurant";
ALTER TABLE "Restaurant" RENAME CONSTRAINT "Client_pkey" TO "Restaurant_pkey";
ALTER INDEX "Client_status_idx" RENAME TO "Restaurant_status_idx";

-- businessType and industry both described "what kind of food place is this".
-- One column, one meaning.
ALTER TABLE "Restaurant" RENAME COLUMN "businessType" TO "cuisine";
UPDATE "Restaurant" SET "cuisine" = COALESCE("cuisine", "industry") WHERE "cuisine" IS NULL;
ALTER TABLE "Restaurant" DROP COLUMN "industry";

ALTER TABLE "Restaurant"
  ADD COLUMN "description"         TEXT,
  ADD COLUMN "address"             TEXT,
  ADD COLUMN "branches"            TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "marketingObjectives" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "coverUrl"            TEXT,
  ADD COLUMN "googleBusiness"      JSONB NOT NULL DEFAULT '{}';

-- The old uniqueness was per organization. With one workspace it becomes a
-- plain unique name, so any duplicates carried over from separate agencies are
-- suffixed rather than dropped.
UPDATE "Restaurant" r SET "name" = r."name" || ' (' || r."id" || ')'
WHERE EXISTS (
  SELECT 1 FROM "Restaurant" other
  WHERE other."name" = r."name" AND other."id" < r."id"
);

DROP INDEX IF EXISTS "Client_organizationId_name_key";
DROP INDEX IF EXISTS "Client_organizationId_idx";
ALTER TABLE "Restaurant" DROP CONSTRAINT IF EXISTS "Client_organizationId_fkey";
ALTER TABLE "Restaurant" DROP COLUMN "organizationId";
CREATE UNIQUE INDEX "Restaurant_name_key" ON "Restaurant"("name");

-- ---------------------------------------------------------------- 5. clientId -> restaurantId

-- Foreign keys are dropped by their old names and re-added against Restaurant
-- once the column has been renamed. The column, and therefore the data, is
-- never dropped.
ALTER TABLE "Brand"             DROP CONSTRAINT "Brand_clientId_fkey";
ALTER TABLE "Media"             DROP CONSTRAINT "Media_clientId_fkey";
ALTER TABLE "Campaign"          DROP CONSTRAINT "Campaign_clientId_fkey";
ALTER TABLE "Content"           DROP CONSTRAINT "Content_clientId_fkey";
ALTER TABLE "AnalyticsSnapshot" DROP CONSTRAINT "AnalyticsSnapshot_clientId_fkey";
ALTER TABLE "Report"            DROP CONSTRAINT "Report_clientId_fkey";
ALTER TABLE "Notification"      DROP CONSTRAINT "Notification_clientId_fkey";
ALTER TABLE "Integration"       DROP CONSTRAINT "Integration_clientId_fkey";
ALTER TABLE "AiUsage"           DROP CONSTRAINT "AiUsage_clientId_fkey";
ALTER TABLE "User"              DROP CONSTRAINT "User_clientId_fkey";

ALTER TABLE "Brand"             RENAME COLUMN "clientId" TO "restaurantId";
ALTER TABLE "Media"             RENAME COLUMN "clientId" TO "restaurantId";
ALTER TABLE "Campaign"          RENAME COLUMN "clientId" TO "restaurantId";
ALTER TABLE "Content"           RENAME COLUMN "clientId" TO "restaurantId";
ALTER TABLE "CalendarEvent"     RENAME COLUMN "clientId" TO "restaurantId";
ALTER TABLE "AnalyticsSnapshot" RENAME COLUMN "clientId" TO "restaurantId";
ALTER TABLE "Report"            RENAME COLUMN "clientId" TO "restaurantId";
ALTER TABLE "Notification"      RENAME COLUMN "clientId" TO "restaurantId";
ALTER TABLE "Integration"       RENAME COLUMN "clientId" TO "restaurantId";
ALTER TABLE "AiUsage"           RENAME COLUMN "clientId" TO "restaurantId";

ALTER INDEX "Brand_clientId_key"                RENAME TO "Brand_restaurantId_key";
ALTER INDEX "Media_clientId_idx"                RENAME TO "Media_restaurantId_idx";
ALTER INDEX "Campaign_clientId_idx"             RENAME TO "Campaign_restaurantId_idx";
ALTER INDEX "Content_clientId_idx"              RENAME TO "Content_restaurantId_idx";
ALTER INDEX "CalendarEvent_clientId_idx"        RENAME TO "CalendarEvent_restaurantId_idx";
ALTER INDEX "AnalyticsSnapshot_clientId_date_idx" RENAME TO "AnalyticsSnapshot_restaurantId_date_idx";
ALTER INDEX "Report_clientId_idx"               RENAME TO "Report_restaurantId_idx";
ALTER INDEX "Notification_clientId_idx"         RENAME TO "Notification_restaurantId_idx";
ALTER INDEX "Integration_clientId_platform_key" RENAME TO "Integration_restaurantId_platform_key";
ALTER INDEX "AiUsage_clientId_idx"              RENAME TO "AiUsage_restaurantId_idx";

-- ---------------------------------------------------------------- 6. drop the tenancy column

ALTER TABLE "User"              DROP CONSTRAINT "User_organizationId_fkey";
ALTER TABLE "Campaign"          DROP CONSTRAINT "Campaign_organizationId_fkey";
ALTER TABLE "Content"           DROP CONSTRAINT "Content_organizationId_fkey";
ALTER TABLE "Media"             DROP CONSTRAINT "Media_organizationId_fkey";
ALTER TABLE "Report"            DROP CONSTRAINT "Report_organizationId_fkey";
ALTER TABLE "Notification"      DROP CONSTRAINT "Notification_organizationId_fkey";
ALTER TABLE "Integration"       DROP CONSTRAINT "Integration_organizationId_fkey";
ALTER TABLE "AuditLog"          DROP CONSTRAINT "AuditLog_organizationId_fkey";
ALTER TABLE "AiUsage"           DROP CONSTRAINT "AiUsage_organizationId_fkey";

ALTER TABLE "User"              DROP COLUMN "organizationId", DROP COLUMN "clientId";
ALTER TABLE "Brand"             DROP COLUMN "organizationId";
ALTER TABLE "Media"             DROP COLUMN "organizationId";
ALTER TABLE "Campaign"          DROP COLUMN "organizationId";
ALTER TABLE "Content"           DROP COLUMN "organizationId";
ALTER TABLE "CalendarEvent"     DROP COLUMN "organizationId";
ALTER TABLE "AnalyticsSnapshot" DROP COLUMN "organizationId";
ALTER TABLE "Report"            DROP COLUMN "organizationId";
ALTER TABLE "Notification"      DROP COLUMN "organizationId";
ALTER TABLE "Integration"       DROP COLUMN "organizationId";
ALTER TABLE "AuditLog"          DROP COLUMN "organizationId";
ALTER TABLE "AiUsage"           DROP COLUMN "organizationId", DROP COLUMN "userId";

DROP TABLE "Organization";

-- ---------------------------------------------------------------- 7. new columns

ALTER TABLE "Brand"
  RENAME COLUMN "businessType" TO "cuisine";
UPDATE "Brand" SET "cuisine" = COALESCE("cuisine", "industry") WHERE "cuisine" IS NULL;
ALTER TABLE "Brand"
  DROP COLUMN "industry",
  ADD COLUMN "visualStyle" TEXT,
  ADD COLUMN "headingFont" TEXT,
  ADD COLUMN "bodyFont"    TEXT;

ALTER TABLE "Content"
  ADD COLUMN "brief" TEXT,
  ADD COLUMN "notes" TEXT;

ALTER TABLE "AnalyticsSnapshot" ADD COLUMN "leads" INTEGER NOT NULL DEFAULT 0;

-- The Gulf market is the target; existing rows keep whatever they were created
-- with, only the column default changes.
ALTER TABLE "Campaign" ALTER COLUMN "currency" SET DEFAULT 'SAR';
ALTER TABLE "Content"  ALTER COLUMN "timezone" SET DEFAULT 'Asia/Riyadh';
ALTER TABLE "CalendarEvent" ALTER COLUMN "timezone" SET DEFAULT 'Asia/Riyadh';

CREATE INDEX "Content_type_idx"    ON "Content"("type");
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");
CREATE INDEX "AiUsage_createdAt_idx"  ON "AiUsage"("createdAt");
DROP INDEX IF EXISTS "AuditLog_organizationId_createdAt_idx";
DROP INDEX IF EXISTS "AiUsage_organizationId_createdAt_idx";
DROP INDEX IF EXISTS "AnalyticsSnapshot_organizationId_idx";
DROP INDEX IF EXISTS "Brand_organizationId_idx";
DROP INDEX IF EXISTS "CalendarEvent_organizationId_idx";
DROP INDEX IF EXISTS "Campaign_organizationId_idx";
DROP INDEX IF EXISTS "Content_organizationId_idx";
DROP INDEX IF EXISTS "Integration_organizationId_idx";
DROP INDEX IF EXISTS "Media_organizationId_idx";
DROP INDEX IF EXISTS "Notification_organizationId_idx";
DROP INDEX IF EXISTS "Report_organizationId_idx";
DROP INDEX IF EXISTS "User_organizationId_idx";
DROP INDEX IF EXISTS "User_clientId_idx";
DROP INDEX IF EXISTS "User_role_idx";

-- ---------------------------------------------------------------- 8. new tables

CREATE TABLE "Workspace" (
    "id"          TEXT NOT NULL DEFAULT 'workspace',
    "name"        TEXT NOT NULL DEFAULT 'Restaurant Marketing OS',
    "currency"    TEXT NOT NULL DEFAULT 'SAR',
    "timezone"    TEXT NOT NULL DEFAULT 'Asia/Riyadh',
    "locale"      "Language" NOT NULL DEFAULT 'EN',
    "logoUrl"     TEXT,
    "preferences" JSONB NOT NULL DEFAULT '{}',
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Ad" (
    "id"           TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "campaignId"   TEXT NOT NULL,
    "name"         TEXT NOT NULL,
    "platform"     "Platform" NOT NULL,
    "objective"    "CampaignObjective" NOT NULL DEFAULT 'AWARENESS',
    "status"       "AdStatus" NOT NULL DEFAULT 'DRAFT',
    "headline"     TEXT,
    "primaryText"  TEXT,
    "cta"          TEXT,
    "audience"     TEXT,
    "creativeId"   TEXT,
    "budget"       DECIMAL(12,2) NOT NULL DEFAULT 0,
    "spend"        DECIMAL(12,2) NOT NULL DEFAULT 0,
    "impressions"  INTEGER NOT NULL DEFAULT 0,
    "reach"        INTEGER NOT NULL DEFAULT 0,
    "clicks"       INTEGER NOT NULL DEFAULT 0,
    "leads"        INTEGER NOT NULL DEFAULT 0,
    "conversions"  INTEGER NOT NULL DEFAULT 0,
    "revenue"      DECIMAL(12,2) NOT NULL DEFAULT 0,
    "metricsAt"    TIMESTAMP(3),
    "startDate"    TIMESTAMP(3),
    "endDate"      TIMESTAMP(3),
    "notes"        TEXT,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ad_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Task" (
    "id"           TEXT NOT NULL,
    "restaurantId" TEXT,
    "campaignId"   TEXT,
    "assigneeId"   TEXT,
    "title"        TEXT NOT NULL,
    "details"      TEXT,
    "status"       "TaskStatus" NOT NULL DEFAULT 'TODO',
    "priority"     "TaskPriority" NOT NULL DEFAULT 'MEDIUM',
    "dueAt"        TIMESTAMP(3),
    "completedAt"  TIMESTAMP(3),
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Ad_restaurantId_idx"   ON "Ad"("restaurantId");
CREATE INDEX "Ad_campaignId_idx"     ON "Ad"("campaignId");
CREATE INDEX "Ad_status_idx"         ON "Ad"("status");
CREATE INDEX "Ad_platform_idx"       ON "Ad"("platform");
CREATE INDEX "Task_restaurantId_idx" ON "Task"("restaurantId");
CREATE INDEX "Task_status_idx"       ON "Task"("status");
CREATE INDEX "Task_dueAt_idx"        ON "Task"("dueAt");

-- ---------------------------------------------------------------- 9. re-establish foreign keys

ALTER TABLE "Brand"             ADD CONSTRAINT "Brand_restaurantId_fkey"             FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE  ON UPDATE CASCADE;
ALTER TABLE "Media"             ADD CONSTRAINT "Media_restaurantId_fkey"             FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Campaign"          ADD CONSTRAINT "Campaign_restaurantId_fkey"          FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE  ON UPDATE CASCADE;
ALTER TABLE "Content"           ADD CONSTRAINT "Content_restaurantId_fkey"           FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE  ON UPDATE CASCADE;
ALTER TABLE "AnalyticsSnapshot" ADD CONSTRAINT "AnalyticsSnapshot_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE  ON UPDATE CASCADE;
ALTER TABLE "Report"            ADD CONSTRAINT "Report_restaurantId_fkey"            FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE  ON UPDATE CASCADE;
ALTER TABLE "Notification"      ADD CONSTRAINT "Notification_restaurantId_fkey"      FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE  ON UPDATE CASCADE;
ALTER TABLE "Integration"       ADD CONSTRAINT "Integration_restaurantId_fkey"       FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE  ON UPDATE CASCADE;
ALTER TABLE "AiUsage"           ADD CONSTRAINT "AiUsage_restaurantId_fkey"           FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Ad"   ADD CONSTRAINT "Ad_restaurantId_fkey"   FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE  ON UPDATE CASCADE;
ALTER TABLE "Ad"   ADD CONSTRAINT "Ad_campaignId_fkey"     FOREIGN KEY ("campaignId")   REFERENCES "Campaign"("id")   ON DELETE CASCADE  ON UPDATE CASCADE;
ALTER TABLE "Ad"   ADD CONSTRAINT "Ad_creativeId_fkey"     FOREIGN KEY ("creativeId")   REFERENCES "Media"("id")      ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE  ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_campaignId_fkey"   FOREIGN KEY ("campaignId")   REFERENCES "Campaign"("id")   ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_assigneeId_fkey"   FOREIGN KEY ("assigneeId")   REFERENCES "User"("id")       ON DELETE SET NULL ON UPDATE CASCADE;
