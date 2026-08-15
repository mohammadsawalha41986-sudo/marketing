/**
 * Demo data.
 *
 * Creates one agency with four clients across different verticals, each with a
 * full Brand DNA, campaigns, content at every stage of the approval flow, and 90
 * days of analytics. The businesses are fictional; the numbers are generated
 * with plausible per-platform rates so the dashboards and the AI analyst have
 * something real to compute against.
 *
 * Safe to re-run: it clears the demo organization first.
 */

import {
  ApprovalStatus, CampaignObjective, CampaignStatus, ClientStatus, ContentStatus, ContentType,
  IntegrationStatus, Language, NotificationType, Platform, PrismaClient, Prisma,
  ReportType, Role, SubscriptionStatus,
} from '@prisma/client';
import argon2 from 'argon2';
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../.env') });

const prisma = new PrismaClient();

const DEMO_PASSWORD = 'Passw0rd!demo';
const ORG_SLUG = 'northwind-collective';

/** Deterministic PRNG so re-seeding produces the same dashboards. */
function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

const daysAgo = (n: number) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - n);
  date.setUTCHours(0, 0, 0, 0);
  return date;
};

const daysAhead = (n: number) => daysAgo(-n);

async function hash(password: string) {
  return argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
}

// ---------------------------------------------------------------- plans

const PLANS = [
  {
    key: 'starter', name: 'Starter', sortOrder: 1,
    description: 'One brand, one marketer, everything you need to run it properly.',
    priceMonthly: 49, priceYearly: 490,
    maxClients: 1, maxUsers: 3, maxCampaigns: 10, maxAiPerMonth: 200, maxStorageMb: 2048, maxIntegrations: 2,
    features: ['1 client', 'AI content studio', 'Content calendar', 'Client portal', 'Monthly reports'],
  },
  {
    key: 'professional', name: 'Professional', sortOrder: 2,
    description: 'For small agencies running a handful of accounts.',
    priceMonthly: 149, priceYearly: 1490,
    maxClients: 10, maxUsers: 10, maxCampaigns: 100, maxAiPerMonth: 2000, maxStorageMb: 20480, maxIntegrations: 8,
    features: ['10 clients', 'Approval workflow', 'AI marketing analyst', 'All integrations', 'White-label reports'],
  },
  {
    key: 'agency', name: 'Agency', sortOrder: 3,
    description: 'Multi-team agencies with a full client roster.',
    priceMonthly: 399, priceYearly: 3990,
    maxClients: 50, maxUsers: 40, maxCampaigns: 1000, maxAiPerMonth: 10000, maxStorageMb: 102400, maxIntegrations: 40,
    features: ['50 clients', 'Role-based access', 'Audit log', 'Priority support', 'Custom branding'],
  },
  {
    key: 'enterprise', name: 'Enterprise', sortOrder: 4,
    description: 'Unlimited scale with the controls a procurement team asks for.',
    priceMonthly: 1200, priceYearly: 12000,
    maxClients: -1, maxUsers: -1, maxCampaigns: -1, maxAiPerMonth: -1, maxStorageMb: -1, maxIntegrations: -1,
    features: ['Unlimited clients', 'SSO', 'Data residency', 'Dedicated support', 'SLA'],
  },
];

// ---------------------------------------------------------------- clients

interface ClientSeed {
  key: string;
  name: string;
  businessName: string;
  businessType: string;
  industry: string;
  location: string;
  website: string;
  email: string;
  phone: string;
  language: Language;
  colors: { primary: string; secondary: string; accent: string; background: string; text: string };
  font: string;
  brand: {
    description: string;
    targetAudience: string;
    personality: string[];
    toneOfVoice: string;
    values: string[];
    products: string[];
    services: string[];
    usps: string[];
    offers: string[];
    keywords: string[];
    forbiddenWords: string[];
    ctaStyle: string;
  };
}

const CLIENTS: ClientSeed[] = [
  {
    key: 'zaytoun',
    name: 'Zaytoun Kitchen',
    businessName: 'Zaytoun Kitchen',
    businessType: 'Restaurant',
    industry: 'Food and beverage',
    location: 'Amman, Jordan',
    website: 'https://zaytoun.example.com',
    email: 'hello@zaytoun.example.com',
    phone: '+962 6 000 0000',
    language: Language.AR,
    colors: { primary: '#1F7A5A', secondary: '#C9A227', accent: '#E8613C', background: '#0C1512', text: '#EDF3EF' },
    font: 'Plus Jakarta Sans',
    brand: {
      description: 'Levantine home cooking served in a modern dining room, with everything made from scratch each morning.',
      targetAudience: 'Families and professionals aged 25-50 in west Amman who eat out twice a week and care about ingredients.',
      personality: ['Warm', 'Generous', 'Rooted', 'Unpretentious'],
      toneOfVoice: 'Warm and direct, like a host who is pleased you came',
      values: ['Hospitality', 'Seasonal produce', 'Family recipes'],
      products: ['Mezze platter', 'Charcoal grill', 'Weekend brunch', 'Knafeh'],
      services: ['Dine-in', 'Delivery', 'Private events', 'Catering'],
      usps: ['Everything made fresh each morning', 'Recipes from three generations', 'Produce from Jordan Valley farms'],
      offers: ['Family platter for four', 'Weekday lunch set'],
      keywords: ['Levantine food', 'Amman restaurant', 'mezze', 'family dining'],
      forbiddenWords: ['cheap', 'fast food'],
      ctaStyle: 'احجز طاولتك',
    },
  },
  {
    key: 'cedar-shore',
    name: 'Cedar Shore Hotel',
    businessName: 'Cedar Shore Hotel & Spa',
    businessType: 'Hotel',
    industry: 'Hospitality',
    location: 'Aqaba, Jordan',
    website: 'https://cedarshore.example.com',
    email: 'reservations@cedarshore.example.com',
    phone: '+962 3 000 0000',
    language: Language.EN,
    colors: { primary: '#1C4E80', secondary: '#4FB3BF', accent: '#E4B363', background: '#0A1220', text: '#E9EEF6' },
    font: 'Manrope',
    brand: {
      description: 'A 90-room Red Sea hotel with a dive centre, three restaurants and a spa built around the original 1970s pool.',
      targetAudience: 'Couples and small families booking 3-5 night Red Sea breaks, plus regional business travellers midweek.',
      personality: ['Calm', 'Considered', 'Coastal', 'Quietly luxurious'],
      toneOfVoice: 'Composed and evocative, never breathless',
      values: ['Reef conservation', 'Local sourcing', 'Genuine service'],
      products: ['Sea view rooms', 'Spa day passes', 'Dive packages'],
      services: ['Diving', 'Spa', 'Conferences', 'Airport transfer'],
      usps: ['Private reef access', 'PADI centre on site', 'Half the rooms face the water'],
      offers: ['Stay 3 nights, third night half price', 'Spa and lunch day pass'],
      keywords: ['Aqaba hotel', 'Red Sea diving', 'spa resort'],
      forbiddenWords: ['budget', 'basic'],
      ctaStyle: 'Check availability',
    },
  },
  {
    key: 'atlas-outfitters',
    name: 'Atlas Outfitters',
    businessName: 'Atlas Outfitters',
    businessType: 'Retail store',
    industry: 'Outdoor and apparel',
    location: 'Dubai, UAE',
    website: 'https://atlasoutfitters.example.com',
    email: 'team@atlasoutfitters.example.com',
    phone: '+971 4 000 0000',
    language: Language.EN,
    colors: { primary: '#B4532A', secondary: '#2F4F4F', accent: '#E9C46A', background: '#12100E', text: '#F2EDE7' },
    font: 'Poppins',
    brand: {
      description: 'Two stores and a workshop selling desert and mountain kit, with free repairs for the lifetime of anything bought there.',
      targetAudience: 'Weekend hikers and overlanders aged 28-45 across the GCC who buy once and expect it to last.',
      personality: ['Practical', 'Durable', 'Knowledgeable', 'Honest'],
      toneOfVoice: 'Plain and expert, the way good staff talk on the shop floor',
      values: ['Repair over replace', 'Field-tested only', 'No exaggerated specs'],
      products: ['Trail packs', 'Desert tents', 'Insulated layers', 'Boots'],
      services: ['Free lifetime repairs', 'Kit fitting', 'Guided weekends'],
      usps: ['Free repairs forever', 'Everything tested in the Hajar mountains', 'Staff who use the kit'],
      offers: ['Trade in old gear for store credit', 'Free fitting appointment'],
      keywords: ['hiking gear Dubai', 'overlanding', 'desert camping'],
      forbiddenWords: ['revolutionary', 'game-changing', 'ultimate'],
      ctaStyle: 'Shop the range',
    },
  },
  {
    key: 'lumen-skincare',
    name: 'Lumen Skincare',
    businessName: 'Lumen Skincare',
    businessType: 'E-commerce',
    industry: 'Beauty and personal care',
    location: 'Riyadh, Saudi Arabia',
    website: 'https://lumenskin.example.com',
    email: 'care@lumenskin.example.com',
    phone: '+966 11 000 0000',
    language: Language.AR,
    colors: { primary: '#8E6BB5', secondary: '#F2B5D4', accent: '#5BC0BE', background: '#120E18', text: '#F0EAF5' },
    font: 'Inter',
    brand: {
      description: 'A direct-to-consumer skincare line formulated for hot, dry climates, sold in refillable glass.',
      targetAudience: 'Women aged 22-40 in the Gulf who read ingredient lists and buy online.',
      personality: ['Clear', 'Evidence-led', 'Modern', 'Calm'],
      toneOfVoice: 'Straightforward and scientific without being cold',
      values: ['Ingredient transparency', 'Refillable packaging', 'No unverifiable claims'],
      products: ['Barrier serum', 'SPF 50 fluid', 'Ceramide cream', 'Refill pouches'],
      services: ['Subscription refills', 'Skin consultation'],
      usps: ['Formulated for 45°C summers', 'Full concentrations printed on every box', 'Refills cost 40% less'],
      offers: ['First refill free', 'Bundle of three'],
      keywords: ['skincare Saudi', 'barrier repair', 'SPF for hot climate'],
      forbiddenWords: ['miracle', 'anti-aging', 'cure'],
      ctaStyle: 'تسوقي الآن',
    },
  },
];

/** Per-platform behaviour, used to generate believable daily numbers. */
const PLATFORM_PROFILE: Record<string, { cpm: number; ctr: number; cvr: number; aov: number; weight: number }> = {
  INSTAGRAM: { cpm: 6.2, ctr: 0.0125, cvr: 0.031, aov: 78, weight: 0.3 },
  FACEBOOK: { cpm: 5.1, ctr: 0.0098, cvr: 0.028, aov: 82, weight: 0.24 },
  TIKTOK: { cpm: 4.3, ctr: 0.0142, cvr: 0.019, aov: 64, weight: 0.18 },
  SNAPCHAT: { cpm: 3.6, ctr: 0.0088, cvr: 0.014, aov: 58, weight: 0.1 },
  GOOGLE_ADS: { cpm: 11.4, ctr: 0.0412, cvr: 0.052, aov: 96, weight: 0.15 },
  GOOGLE_BUSINESS: { cpm: 2.1, ctr: 0.0325, cvr: 0.061, aov: 70, weight: 0.03 },
};

async function main() {
  console.log('Seeding Marketing OS demo data…');

  // ------------------------------------------------------------ reset
  const existing = await prisma.organization.findUnique({ where: { slug: ORG_SLUG }, select: { id: true } });
  if (existing) {
    // Cascades clear clients, campaigns, content, media, analytics and the rest.
    await prisma.organization.delete({ where: { id: existing.id } });
    console.log('  cleared previous demo organization');
  }
  await prisma.user.deleteMany({ where: { email: 'root@marketingos.example.com' } });

  // ------------------------------------------------------------ plans
  const plans = new Map<string, { id: string }>();
  for (const plan of PLANS) {
    const record = await prisma.plan.upsert({
      where: { key: plan.key },
      create: {
        ...plan,
        priceMonthly: new Prisma.Decimal(plan.priceMonthly),
        priceYearly: new Prisma.Decimal(plan.priceYearly),
      },
      update: {
        ...plan,
        priceMonthly: new Prisma.Decimal(plan.priceMonthly),
        priceYearly: new Prisma.Decimal(plan.priceYearly),
      },
      select: { id: true, key: true },
    });
    plans.set(plan.key, record);
  }
  console.log(`  ${PLANS.length} plans`);

  // ------------------------------------------------------------ organization
  const organization = await prisma.organization.create({
    data: { name: 'Northwind Collective', slug: ORG_SLUG, locale: Language.EN, timezone: 'Asia/Amman' },
  });

  const passwordHash = await hash(DEMO_PASSWORD);

  const [superAdmin, agencyAdmin, agencyStaff] = await Promise.all([
    prisma.user.create({
      data: {
        name: 'Platform Root', email: 'root@marketingos.example.com', passwordHash,
        role: Role.SUPER_ADMIN, organizationId: organization.id, themePref: 'dark',
      },
    }),
    prisma.user.create({
      data: {
        name: 'Rana Haddad', email: 'admin@northwind.example.com', passwordHash,
        role: Role.AGENCY_ADMIN, organizationId: organization.id, themePref: 'dark',
      },
    }),
    prisma.user.create({
      data: {
        name: 'Omar Nassar', email: 'staff@northwind.example.com', passwordHash,
        role: Role.AGENCY_STAFF, organizationId: organization.id, themePref: 'dark',
      },
    }),
  ]);

  await prisma.subscription.create({
    data: {
      organizationId: organization.id,
      planId: plans.get('agency')!.id,
      status: SubscriptionStatus.ACTIVE,
      startDate: daysAgo(210),
      renewalDate: daysAhead(155),
    },
  });

  console.log('  organization, 3 agency users, 1 subscription');

  // ------------------------------------------------------------ clients
  let totalSnapshots = 0;
  let totalContent = 0;

  for (const [index, seed] of CLIENTS.entries()) {
    const random = rng(1000 + index * 97);

    const client = await prisma.client.create({
      data: {
        organizationId: organization.id,
        name: seed.name,
        businessName: seed.businessName,
        email: seed.email,
        phone: seed.phone,
        businessType: seed.businessType,
        industry: seed.industry,
        website: seed.website,
        location: seed.location,
        status: ClientStatus.ACTIVE,
        socialLinks: {
          instagram: `https://instagram.com/${seed.key}`,
          facebook: `https://facebook.com/${seed.key}`,
          tiktok: `https://tiktok.com/@${seed.key}`,
        },
        notes: `Demo account. ${seed.brand.description}`,
        brand: {
          create: {
            organizationId: organization.id,
            businessName: seed.businessName,
            businessType: seed.businessType,
            industry: seed.industry,
            location: seed.location,
            preferredLanguage: seed.language,
            primaryColor: seed.colors.primary,
            secondaryColor: seed.colors.secondary,
            accentColor: seed.colors.accent,
            backgroundColor: seed.colors.background,
            textColor: seed.colors.text,
            fontFamily: seed.font,
            paletteApproved: true,
            ...seed.brand,
          },
        },
      },
    });

    // Client portal users.
    await prisma.user.createMany({
      data: [
        {
          name: `${seed.name} Owner`,
          email: `owner@${seed.key}.example.com`,
          passwordHash,
          role: Role.CLIENT_ADMIN,
          organizationId: organization.id,
          clientId: client.id,
          locale: seed.language,
        },
        {
          name: `${seed.name} Team`,
          email: `team@${seed.key}.example.com`,
          passwordHash,
          role: Role.CLIENT_USER,
          organizationId: organization.id,
          clientId: client.id,
          locale: seed.language,
        },
      ],
    });

    await prisma.subscription.create({
      data: {
        organizationId: organization.id,
        clientId: client.id,
        planId: plans.get(index === 0 ? 'professional' : index === 3 ? 'agency' : 'starter')!.id,
        status: index === 2 ? SubscriptionStatus.TRIALING : SubscriptionStatus.ACTIVE,
        startDate: daysAgo(120 - index * 10),
        renewalDate: daysAhead(245 + index * 10),
      },
    });

    // Integrations: created and visibly disconnected, because no adapter exists.
    await prisma.integration.createMany({
      data: [Platform.INSTAGRAM, Platform.FACEBOOK, Platform.TIKTOK, Platform.GOOGLE_ADS].map((platform) => ({
        organizationId: organization.id,
        clientId: client.id,
        platform,
        status: IntegrationStatus.DISCONNECTED,
      })),
    });

    // -------------------------------------------------- campaigns
    const campaignPlan = [
      {
        name: seed.key === 'zaytoun' ? 'Ramadan family platters' : seed.key === 'cedar-shore' ? 'Red Sea autumn escapes' : seed.key === 'atlas-outfitters' ? 'Winter trail season' : 'Barrier repair launch',
        objective: CampaignObjective.SALES,
        status: CampaignStatus.RUNNING,
        budget: 12000 + index * 3500,
        start: daysAgo(45),
        end: daysAhead(15),
        platforms: [Platform.INSTAGRAM, Platform.FACEBOOK, Platform.GOOGLE_ADS],
      },
      {
        name: seed.key === 'zaytoun' ? 'Weekday lunch set' : seed.key === 'cedar-shore' ? 'Midweek business rate' : seed.key === 'atlas-outfitters' ? 'Repair workshop awareness' : 'Refill subscription push',
        objective: CampaignObjective.TRAFFIC,
        status: CampaignStatus.RUNNING,
        budget: 6000 + index * 1200,
        start: daysAgo(30),
        end: daysAhead(30),
        platforms: [Platform.INSTAGRAM, Platform.TIKTOK],
      },
      {
        name: seed.key === 'zaytoun' ? 'Brand film — the morning prep' : seed.key === 'cedar-shore' ? 'Reef conservation story' : seed.key === 'atlas-outfitters' ? 'Field-tested series' : 'Ingredient transparency series',
        objective: CampaignObjective.AWARENESS,
        status: CampaignStatus.COMPLETED,
        budget: 8000,
        start: daysAgo(120),
        end: daysAgo(60),
        platforms: [Platform.INSTAGRAM, Platform.TIKTOK, Platform.SNAPCHAT],
      },
      {
        name: seed.key === 'zaytoun' ? 'New branch opening' : seed.key === 'cedar-shore' ? 'Spring dive packages' : seed.key === 'atlas-outfitters' ? 'Summer overlanding' : 'SPF season',
        objective: CampaignObjective.LEADS,
        status: CampaignStatus.DRAFT,
        budget: 9500,
        start: daysAhead(20),
        end: daysAhead(80),
        platforms: [Platform.INSTAGRAM, Platform.GOOGLE_ADS],
      },
    ];

    for (const [campaignIndex, plan] of campaignPlan.entries()) {
      const campaign = await prisma.campaign.create({
        data: {
          organizationId: organization.id,
          clientId: client.id,
          name: plan.name,
          objective: plan.objective,
          status: plan.status,
          budget: new Prisma.Decimal(plan.budget),
          currency: 'USD',
          startDate: plan.start,
          endDate: plan.end,
          targetAudience: seed.brand.targetAudience,
          locations: [seed.location],
          kpi: plan.objective === CampaignObjective.SALES ? 'ROAS above 3.0x' : plan.objective === CampaignObjective.TRAFFIC ? 'Cost per click under $0.60' : 'Reach 250k unique people',
          platforms: {
            create: plan.platforms.map((platform) => ({
              platform,
              budget: new Prisma.Decimal(Math.round(plan.budget / plan.platforms.length)),
            })),
          },
        },
      });

      // ------------------------------------------ analytics
      // Only campaigns that have actually run get snapshots.
      if (plan.status === CampaignStatus.DRAFT) continue;

      const firstDay = Math.min(90, Math.round((Date.now() - plan.start.getTime()) / 86400000));
      const lastDay = Math.max(0, Math.round((Date.now() - Math.min(plan.end.getTime(), Date.now())) / 86400000));

      const rows: Prisma.AnalyticsSnapshotCreateManyInput[] = [];
      let spent = 0;

      for (let day = firstDay; day >= lastDay; day -= 1) {
        const date = daysAgo(day);
        // Weekends run hotter for these verticals; the trend drifts slowly.
        const weekend = [5, 6].includes(date.getUTCDay()) ? 1.22 : 1;
        const drift = 1 + Math.sin((firstDay - day) / 9) * 0.14 + (random() - 0.5) * 0.12;
        const dailyBudget = (plan.budget / Math.max(1, firstDay - lastDay + 1)) * weekend * drift;

        for (const platform of plan.platforms) {
          const profile = PLATFORM_PROFILE[platform]!;
          const share = profile.weight / plan.platforms.reduce((sum, p) => sum + PLATFORM_PROFILE[p]!.weight, 0);
          const spend = Math.max(0, dailyBudget * share * (0.85 + random() * 0.3));

          const impressions = Math.round((spend / profile.cpm) * 1000);
          const reach = Math.round(impressions * (0.55 + random() * 0.2));
          const clicks = Math.round(impressions * profile.ctr * (0.8 + random() * 0.45));
          const conversions = Math.round(clicks * profile.cvr * (0.7 + random() * 0.6));
          const revenue = conversions * profile.aov * (0.85 + random() * 0.4);
          const engagements = Math.round(impressions * (0.012 + random() * 0.02));

          spent += spend;
          rows.push({
            organizationId: organization.id,
            clientId: client.id,
            campaignId: campaign.id,
            platform,
            date,
            spend: new Prisma.Decimal(spend.toFixed(2)),
            reach,
            impressions,
            clicks,
            conversions,
            revenue: new Prisma.Decimal(revenue.toFixed(2)),
            engagements,
          });
        }
      }

      if (rows.length > 0) {
        // The daily generator drifts above plan, which would leave every campaign
        // looking overspent. Normalise to a believable share of budget instead —
        // and leave the first campaign of each client hot, so the budget alert
        // has something real to fire on.
        const targetFraction = campaignIndex === 0 ? 0.97 + random() * 0.12 : 0.62 + random() * 0.26;
        const scale = spent === 0 ? 1 : (plan.budget * targetFraction) / spent;

        let scaledTotal = 0;
        for (const row of rows) {
          const scaled = Number(String(row.spend)) * scale;
          row.spend = new Prisma.Decimal(scaled.toFixed(2));
          scaledTotal += scaled;
        }

        await prisma.analyticsSnapshot.createMany({ data: rows, skipDuplicates: true });
        await prisma.campaign.update({
          where: { id: campaign.id },
          data: { spend: new Prisma.Decimal(scaledTotal.toFixed(2)) },
        });
        totalSnapshots += rows.length;
      }

      // ------------------------------------------ content
      const contentPlan: Array<{ status: ContentStatus; type: ContentType; platform: Platform; offsetDays: number }> = [
        { status: ContentStatus.PUBLISHED, type: ContentType.POST, platform: Platform.INSTAGRAM, offsetDays: -12 },
        { status: ContentStatus.PUBLISHED, type: ContentType.REEL, platform: Platform.TIKTOK, offsetDays: -6 },
        { status: ContentStatus.SCHEDULED, type: ContentType.CAROUSEL, platform: Platform.INSTAGRAM, offsetDays: 3 },
        { status: ContentStatus.SUBMITTED, type: ContentType.AD, platform: Platform.FACEBOOK, offsetDays: 5 },
        { status: ContentStatus.DRAFT, type: ContentType.STORY, platform: Platform.INSTAGRAM, offsetDays: 8 },
      ];

      // Only the two live campaigns carry a full content set.
      const wanted = campaignIndex < 2 ? contentPlan : contentPlan.slice(0, 2);

      for (const [contentIndex, item] of wanted.entries()) {
        const language = seed.language;
        const isArabic = language === Language.AR;
        const offer = seed.brand.offers[contentIndex % seed.brand.offers.length]!;
        const product = seed.brand.products[contentIndex % seed.brand.products.length]!;

        const headline = isArabic ? `${offer} على ${product} من ${seed.businessName}` : `${offer} on ${product} at ${seed.businessName}`;
        const caption = isArabic
          ? `${headline}\n${seed.brand.description}\n${seed.brand.ctaStyle} 👇`
          : `${headline}\n${seed.brand.description}\n${seed.brand.ctaStyle} 👇`;

        const content = await prisma.content.create({
          data: {
            organizationId: organization.id,
            clientId: client.id,
            campaignId: campaign.id,
            authorId: contentIndex % 2 === 0 ? agencyStaff.id : agencyAdmin.id,
            name: `${plan.name} — ${item.type.toLowerCase()} ${contentIndex + 1}`,
            type: item.type,
            status: item.status,
            platform: item.platform,
            language,
            tone: seed.brand.toneOfVoice,
            productService: product,
            offer,
            audience: seed.brand.targetAudience,
            headline,
            caption,
            primaryText: caption,
            shortText: `${offer} — ${product}`,
            longText: `${seed.businessName}\n\n${seed.brand.description}\n\n${seed.brand.usps.map((u) => `• ${u}`).join('\n')}\n\n${seed.brand.ctaStyle}.`,
            slogan: `${seed.businessName} — ${seed.brand.usps[0]}`,
            cta: seed.brand.ctaStyle,
            aiGenerated: contentIndex % 2 === 0,
            timezone: 'Asia/Amman',
            scheduledAt:
              item.status === ContentStatus.DRAFT ? null : daysAhead(item.offsetDays),
            publishedAt: item.status === ContentStatus.PUBLISHED ? daysAhead(item.offsetDays) : null,
            hashtags: {
              create: seed.brand.keywords.slice(0, 5).map((keyword) => ({
                tag: `#${keyword.replace(/[^\p{L}\p{N}]/gu, '')}`,
                source: contentIndex % 2 === 0 ? 'ai' : 'manual',
              })),
            },
          },
        });
        totalContent += 1;

        if (item.status === ContentStatus.SCHEDULED || item.status === ContentStatus.PUBLISHED) {
          await prisma.calendarEvent.create({
            data: {
              contentId: content.id,
              organizationId: organization.id,
              clientId: client.id,
              title: content.name,
              platform: content.platform,
              startAt: content.scheduledAt ?? daysAhead(item.offsetDays),
              timezone: 'Asia/Amman',
            },
          });
        }

        if (item.status === ContentStatus.SUBMITTED) {
          await prisma.approval.create({
            data: {
              organizationId: organization.id,
              clientId: client.id,
              contentId: content.id,
              status: ApprovalStatus.PENDING,
            },
          });
        }

        if (item.status === ContentStatus.PUBLISHED) {
          await prisma.approval.create({
            data: {
              organizationId: organization.id,
              clientId: client.id,
              contentId: content.id,
              status: ApprovalStatus.APPROVED,
              decidedById: agencyAdmin.id,
              decidedAt: daysAgo(Math.abs(item.offsetDays) + 2),
              note: 'Approved as drafted.',
            },
          });
        }
      }
    }

    console.log(`  client ${index + 1}/${CLIENTS.length}: ${seed.name}`);
  }

  // ------------------------------------------------------------ notifications
  const agencyUsers = [superAdmin, agencyAdmin, agencyStaff];
  const pendingCount = await prisma.approval.count({ where: { organizationId: organization.id, status: ApprovalStatus.PENDING } });

  await prisma.notification.createMany({
    data: agencyUsers.flatMap((user) => [
      {
        organizationId: organization.id,
        userId: user.id,
        type: NotificationType.APPROVAL_REQUESTED,
        title: `${pendingCount} items awaiting client approval`,
        body: 'Content cannot be scheduled until it is signed off.',
        link: '/app/approvals',
      },
      {
        organizationId: organization.id,
        userId: user.id,
        type: NotificationType.AI_ALERT,
        title: 'Run the AI analyst on this month',
        body: 'Thirty days of data are in. Ask for an analysis before the client call.',
        link: '/app/analytics',
      },
    ]),
  });

  // ------------------------------------------------------------ one saved report
  const firstClient = await prisma.client.findFirst({
    where: { organizationId: organization.id },
    select: { id: true, name: true, businessName: true, logoUrl: true },
  });

  if (firstClient) {
    await prisma.report.create({
      data: {
        organizationId: organization.id,
        clientId: firstClient.id,
        type: ReportType.MONTHLY,
        title: `${firstClient.name} — last 30 days`,
        periodStart: daysAgo(30),
        periodEnd: new Date(),
        payload: {
          note: 'Seeded placeholder. Regenerate from the Reports page to compute figures from live data.',
          client: { id: firstClient.id, name: firstClient.name, businessName: firstClient.businessName },
          period: { from: daysAgo(30).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) },
          totals: {}, changes: {}, platforms: [], campaigns: [], series: [],
          analysis: null, aiMeta: null, generatedAt: new Date().toISOString(),
        } as Prisma.InputJsonValue,
      },
    });
  }

  const counts = {
    clients: await prisma.client.count({ where: { organizationId: organization.id } }),
    users: await prisma.user.count({ where: { organizationId: organization.id } }),
    campaigns: await prisma.campaign.count({ where: { organizationId: organization.id } }),
    content: totalContent,
    snapshots: totalSnapshots,
  };

  console.log('\nDone.');
  console.table(counts);
  console.log(`
Sign in with any of these (password: ${DEMO_PASSWORD})

  Super Admin    root@marketingos.example.com
  Agency Admin   admin@northwind.example.com
  Agency Staff   staff@northwind.example.com
  Client Admin   owner@zaytoun.example.com
  Client User    team@zaytoun.example.com

Other client logins follow the same pattern:
  owner@cedar-shore.example.com, owner@atlas-outfitters.example.com, owner@lumen-skincare.example.com
`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
