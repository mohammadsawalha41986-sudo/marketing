-- Additive: one new table. Nothing existing is altered, dropped or deleted.

CREATE TABLE IF NOT EXISTS "Product" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "name" TEXT NOT NULL,
    "brand" TEXT,
    "description" TEXT,
    "price" DECIMAL(12,2),
    "salePrice" DECIMAL(12,2),
    "currency" TEXT,
    "sku" TEXT,
    "category" TEXT,
    "availability" TEXT,
    "features" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mainMediaId" TEXT,
    "galleryMediaIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sourceVideoUrl" TEXT,
    "extraction" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Product_organizationId_idx" ON "Product"("organizationId");
CREATE INDEX IF NOT EXISTS "Product_clientId_idx" ON "Product"("clientId");

ALTER TABLE "Product" ADD CONSTRAINT "Product_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Product" ADD CONSTRAINT "Product_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
