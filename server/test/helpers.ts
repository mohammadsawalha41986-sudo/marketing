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
      "Task", "Ad", "CalendarEvent", "ContentMedia", "Hashtag",
      "ContentVariant", "Content", "CampaignPlatform", "Campaign", "Media",
      "BrandAsset", "Brand", "Integration", "Session", "User", "Restaurant",
      "Workspace"
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

/** The single operator account. */
export async function createOwner(email = 'owner@marketing.test', name = 'Operator') {
  return prisma.user.create({
    data: { name, email, passwordHash: await hashPassword(PASSWORD), role: Role.OWNER },
  });
}

export interface RestaurantFixture {
  restaurantId: string;
  campaignId: string;
  contentId: string;
  adId: string;
}

/**
 * A restaurant with everything hanging off it: brand, campaign, content, an ad
 * and a few days of analytics, so dashboards and reports have real rows to sum.
 *
 * `slug` keeps names unique between fixtures, which matters because Restaurant
 * names are now globally unique rather than unique per tenant.
 */
export async function createRestaurant(slug: string): Promise<RestaurantFixture> {
  const restaurant = await prisma.restaurant.create({
    data: {
      name: `${slug} restaurant`,
      businessName: `${slug} business`,
      cuisine: 'Levantine',
      brand: {
        create: {
          businessName: `${slug} business`,
          cuisine: 'Levantine',
          description: 'A test restaurant used by the suite.',
          products: ['Mezze platter'],
          usps: ['Made fresh daily'],
          keywords: ['test food'],
          forbiddenWords: ['cheap'],
          preferredLanguage: Language.EN,
        },
      },
    },
  });

  const campaign = await prisma.campaign.create({
    data: {
      restaurantId: restaurant.id,
      name: `${slug} campaign`,
      budget: 10000,
      startDate: new Date(Date.now() - 10 * 86400000),
      endDate: new Date(Date.now() + 20 * 86400000),
      status: 'ACTIVE',
      platforms: { create: [{ platform: Platform.INSTAGRAM, budget: 10000 }] },
    },
  });

  const content = await prisma.content.create({
    data: {
      restaurantId: restaurant.id,
      campaignId: campaign.id,
      name: `${slug} post`,
      platform: Platform.INSTAGRAM,
      status: 'DRAFT',
      headline: 'A headline',
      caption: 'A caption',
    },
  });

  // Deliberately left with metricsAt null: "nothing recorded yet" is a state
  // the API and the report renderer both have to handle.
  const ad = await prisma.ad.create({
    data: {
      restaurantId: restaurant.id,
      campaignId: campaign.id,
      name: `${slug} ad`,
      platform: Platform.INSTAGRAM,
      budget: 2000,
    },
  });

  const snapshots = Array.from({ length: 5 }, (_, index) => ({
    restaurantId: restaurant.id,
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
    leads: 20 + index,
    conversions: 10 + index,
    revenue: 800 + index * 10,
    engagements: 300 + index,
  }));
  await prisma.analyticsSnapshot.createMany({ data: snapshots });

  return {
    restaurantId: restaurant.id,
    campaignId: campaign.id,
    contentId: content.id,
    adId: ad.id,
  };
}

export { prisma };
