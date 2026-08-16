/** Fixtures and a small supertest wrapper that carries cookies and CSRF. */

import request from 'supertest';
import type { Express } from 'express';
import { Language, Platform, Role } from '@prisma/client';

import { createApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { hashPassword } from '../src/lib/password.js';

export const PASSWORD = 'Passw0rd!test';

export const app: Express = createApp();

/** Wipes every table. Order matters only where cascades do not cover it. */
export async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "AiUsage", "AuditLog", "Notification", "Report", "AnalyticsSnapshot",
      "Comment", "Approval", "CalendarEvent", "ContentMedia", "Hashtag",
      "ContentVariant", "AdPublication", "Creative", "VideoCreative", "Content", "CampaignCost",
      "CampaignPlatform", "Campaign", "Product", "Media",
      "BrandAsset", "Brand", "Integration", "Subscription", "Plan",
      "PasswordResetToken", "Session", "User", "Client", "Organization"
    RESTART IDENTITY CASCADE;
  `);
}

/**
 * An authenticated client. Holds the session cookie and echoes the CSRF cookie
 * back as a header, exactly as the browser app does.
 */
export class Agent {
  private cookies: string[] = [];
  private csrf = '';

  constructor(private readonly express: Express) {}

  private applyCookies(raw: string[] | undefined): void {
    if (!raw) return;
    this.cookies = raw.map((cookie) => cookie.split(';')[0] ?? '');
    const csrfCookie = this.cookies.find((cookie) => cookie.startsWith('mos_csrf='));
    if (csrfCookie) this.csrf = decodeURIComponent(csrfCookie.split('=')[1] ?? '');
  }

  private get cookieHeader(): string {
    return this.cookies.join('; ');
  }

  async login(email: string, password = PASSWORD) {
    const response = await request(this.express).post('/api/auth/login').send({ email, password });
    this.applyCookies(response.headers['set-cookie'] as unknown as string[]);
    return response;
  }

  get(path: string) {
    return request(this.express).get(path).set('Cookie', this.cookieHeader);
  }

  post(path: string, body?: object) {
    const req = request(this.express).post(path).set('Cookie', this.cookieHeader).set('x-csrf-token', this.csrf);
    return body === undefined ? req : req.send(body);
  }

  patch(path: string, body?: object) {
    const req = request(this.express).patch(path).set('Cookie', this.cookieHeader).set('x-csrf-token', this.csrf);
    return body === undefined ? req : req.send(body);
  }

  delete(path: string) {
    return request(this.express).delete(path).set('Cookie', this.cookieHeader).set('x-csrf-token', this.csrf);
  }

  /** For the CSRF test: a mutation without the header. */
  postWithoutCsrf(path: string, body?: object) {
    const req = request(this.express).post(path).set('Cookie', this.cookieHeader);
    return body === undefined ? req : req.send(body);
  }
}

export const agent = () => new Agent(app);

export interface Tenant {
  organizationId: string;
  adminId: string;
  adminEmail: string;
  staffEmail: string;
  clientId: string;
  clientAdminEmail: string;
  clientUserEmail: string;
  campaignId: string;
  contentId: string;
}

/** Builds a complete tenant: org, users, client with brand, campaign, content. */
export async function createTenant(slug: string): Promise<Tenant> {
  const passwordHash = await hashPassword(PASSWORD);

  const organization = await prisma.organization.create({
    data: { name: `${slug} agency`, slug },
  });

  const admin = await prisma.user.create({
    data: {
      name: `${slug} admin`, email: `admin@${slug}.test`, passwordHash,
      role: Role.AGENCY_ADMIN, organizationId: organization.id,
    },
  });
  await prisma.user.create({
    data: {
      name: `${slug} staff`, email: `staff@${slug}.test`, passwordHash,
      role: Role.AGENCY_STAFF, organizationId: organization.id,
    },
  });

  const client = await prisma.client.create({
    data: {
      organizationId: organization.id,
      name: `${slug} client`,
      businessName: `${slug} business`,
      brand: {
        create: {
          organizationId: organization.id,
          businessName: `${slug} business`,
          businessType: 'Restaurant',
          description: 'A test business used by the suite.',
          products: ['Mezze platter'],
          usps: ['Made fresh daily'],
          keywords: ['test food'],
          forbiddenWords: ['cheap'],
          preferredLanguage: Language.EN,
        },
      },
    },
  });

  await prisma.user.createMany({
    data: [
      {
        name: `${slug} client admin`, email: `owner@${slug}.test`, passwordHash,
        role: Role.CLIENT_ADMIN, organizationId: organization.id, clientId: client.id,
      },
      {
        name: `${slug} client user`, email: `viewer@${slug}.test`, passwordHash,
        role: Role.CLIENT_USER, organizationId: organization.id, clientId: client.id,
      },
    ],
  });

  const campaign = await prisma.campaign.create({
    data: {
      organizationId: organization.id,
      clientId: client.id,
      name: `${slug} campaign`,
      budget: 10000,
      startDate: new Date(Date.now() - 10 * 86400000),
      endDate: new Date(Date.now() + 20 * 86400000),
      status: 'RUNNING',
      platforms: { create: [{ platform: Platform.INSTAGRAM, budget: 10000 }] },
    },
  });

  const content = await prisma.content.create({
    data: {
      organizationId: organization.id,
      clientId: client.id,
      campaignId: campaign.id,
      name: `${slug} post`,
      platform: Platform.INSTAGRAM,
      headline: 'A headline',
      caption: 'A caption',
    },
  });

  // A few days of analytics so the dashboard and reports have something to sum.
  const snapshots = Array.from({ length: 5 }, (_, index) => ({
    organizationId: organization.id,
    clientId: client.id,
    campaignId: campaign.id,
    platform: Platform.INSTAGRAM,
    date: new Date(Date.UTC(
      new Date().getUTCFullYear(),
      new Date().getUTCMonth(),
      new Date().getUTCDate() - index,
    )),
    spend: 100 + index,
    reach: 5000 + index * 10,
    impressions: 10000 + index * 100,
    clicks: 200 + index,
    conversions: 10 + index,
    revenue: 800 + index * 10,
    engagements: 300 + index,
  }));
  await prisma.analyticsSnapshot.createMany({ data: snapshots });

  return {
    organizationId: organization.id,
    adminId: admin.id,
    adminEmail: admin.email,
    staffEmail: `staff@${slug}.test`,
    clientId: client.id,
    clientAdminEmail: `owner@${slug}.test`,
    clientUserEmail: `viewer@${slug}.test`,
    campaignId: campaign.id,
    contentId: content.id,
  };
}

export async function createSuperAdmin(organizationId: string, email = 'root@platform.test') {
  return prisma.user.create({
    data: {
      name: 'Root', email, passwordHash: await hashPassword(PASSWORD),
      role: Role.SUPER_ADMIN, organizationId,
    },
  });
}

export async function seedPlan() {
  return prisma.plan.create({
    data: {
      key: 'test-plan', name: 'Test plan', priceMonthly: 10, priceYearly: 100,
      maxClients: 5, maxUsers: 5, maxCampaigns: 5, maxAiPerMonth: 50,
      maxStorageMb: 100, maxIntegrations: 2,
    },
  });
}

export { prisma };
