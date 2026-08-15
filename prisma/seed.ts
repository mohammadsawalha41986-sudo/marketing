/**
 * Demo data.
 *
 * One operator with four restaurant clients across the Gulf and Levant, each
 * with a full brand profile, campaigns, ads, content at every stage of the
 * pipeline, tasks and 90 days of analytics. The restaurants are fictional; the
 * numbers are generated with plausible per-platform rates so the dashboards and
 * the AI analyst have something real to compute against.
 *
 * Safe to re-run: it clears everything it created first.
 *
 * This is DEMO data and creates a demo login. Do not run it on a real
 * deployment — use `npm run owner:create` to make the real account instead.
 */

import {
  AdStatus, CampaignObjective, CampaignStatus, ContentStatus, ContentType, IntegrationStatus,
  Language, NotificationType, Platform, PrismaClient, Prisma, ReportType, RestaurantStatus,
  Role, TaskPriority, TaskStatus,
} from '@prisma/client';
import argon2 from 'argon2';
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../.env') });

const prisma = new PrismaClient();

const DEMO_PASSWORD = 'Passw0rd!demo';
const OWNER_EMAIL = 'owner@marketing.example.com';
const CURRENCY = 'SAR';

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

// ---------------------------------------------------------------- restaurants

interface RestaurantSeed {
  key: string;
  name: string;
  businessName: string;
  cuisine: string;
  location: string;
  address: string;
  branches: string[];
  website: string;
  email: string;
  phone: string;
  language: Language;
  objectives: string[];
  colors: { primary: string; secondary: string; accent: string; background: string; text: string };
  font: string;
  brand: {
    description: string;
    targetAudience: string;
    personality: string[];
    toneOfVoice: string;
    visualStyle: string;
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

const RESTAURANTS: RestaurantSeed[] = [
  {
    key: 'sabah-al-leil',
    name: 'Sabah Al Leil',
    businessName: 'Sabah Al Leil Restaurant',
    cuisine: 'Levantine grill',
    location: 'Riyadh, Saudi Arabia',
    address: 'Al Olaya, Tahlia Street, Riyadh',
    branches: ['Tahlia', 'Al Malqa'],
    website: 'https://sabah-al-leil.example.com',
    email: 'hello@sabah-al-leil.example.com',
    phone: '+966 11 000 0000',
    language: Language.AR,
    objectives: ['Fill weekday dinner covers', 'Grow delivery orders 30%', 'Launch the Al Malqa branch'],
    colors: { primary: '#1F7A5A', secondary: '#C9A227', accent: '#E8613C', background: '#0C1512', text: '#EDF3EF' },
    font: 'Cairo',
    brand: {
      description: 'Charcoal grill and Levantine mezze served late, with everything prepared fresh each afternoon.',
      targetAudience: 'Families and groups of friends aged 25-45 in north Riyadh who eat out twice a week and book late tables.',
      personality: ['Warm', 'Generous', 'Rooted', 'Unpretentious'],
      toneOfVoice: 'Warm and direct, like a host who is pleased you came',
      visualStyle: 'Warm charcoal tones, close-up food photography, steam and fire',
      values: ['Hospitality', 'Charcoal over gas', 'Family recipes'],
      products: ['Mixed grill platter', 'Mezze selection', 'Charcoal lamb chops', 'Knafeh'],
      services: ['Dine-in', 'Delivery', 'Private events', 'Catering'],
      usps: ['Grilled over real charcoal', 'Recipes from three generations', 'Open until 2am'],
      offers: ['Family platter for four', 'Weekday lunch set'],
      keywords: ['Riyadh restaurant', 'Levantine grill', 'mezze', 'family dining'],
      forbiddenWords: ['cheap', 'fast food'],
      ctaStyle: 'احجز طاولتك',
    },
  },
  {
    key: 'bahr-seafood',
    name: 'Bahr Seafood',
    businessName: 'Bahr Seafood House',
    cuisine: 'Seafood',
    location: 'Jeddah, Saudi Arabia',
    address: 'Al Hamra Corniche, Jeddah',
    branches: ['Corniche'],
    website: 'https://bahr.example.com',
    email: 'reservations@bahr.example.com',
    phone: '+966 12 000 0000',
    language: Language.AR,
    objectives: ['Own the Friday lunch occasion', 'Build a waiting list for the terrace'],
    colors: { primary: '#1C4E80', secondary: '#4FB3BF', accent: '#E4B363', background: '#0A1220', text: '#E9EEF6' },
    font: 'Tajawal',
    brand: {
      description: 'Red Sea catch landed the same morning, cooked simply, eaten on a terrace over the water.',
      targetAudience: 'Couples and families in Jeddah booking weekend lunches, plus business diners midweek.',
      personality: ['Calm', 'Coastal', 'Considered', 'Fresh'],
      toneOfVoice: 'Composed and evocative, never breathless',
      visualStyle: 'Cool blues and daylight, whole fish on ice, sea horizon',
      values: ['Same-day catch', 'Sustainable species', 'Simple cooking'],
      products: ['Whole grilled hamour', 'Sayadieh', 'Shrimp machboos', 'Mixed grill of the day'],
      services: ['Dine-in', 'Terrace booking', 'Private dining'],
      usps: ['Landed and cooked the same day', 'Terrace over the water', 'Fish chosen at the counter'],
      offers: ['Catch of the day set menu', 'Family seafood platter'],
      keywords: ['Jeddah seafood', 'Red Sea fish', 'corniche restaurant'],
      forbiddenWords: ['frozen', 'budget'],
      ctaStyle: 'احجز الآن',
    },
  },
  {
    key: 'chicken-bar',
    name: 'Chicken Bar',
    businessName: 'Chicken Bar Co.',
    cuisine: 'Fast casual',
    location: 'Dubai, UAE',
    address: 'JLT Cluster D, Dubai',
    branches: ['JLT', 'Business Bay', 'Dubai Marina'],
    website: 'https://chickenbar.example.com',
    email: 'team@chickenbar.example.com',
    phone: '+971 4 000 0000',
    language: Language.EN,
    objectives: ['Drive app downloads', 'Grow weekend delivery volume', 'Launch the loaded fries range'],
    colors: { primary: '#E8613C', secondary: '#F4C430', accent: '#2F4F4F', background: '#12100E', text: '#F2EDE7' },
    font: 'Poppins',
    brand: {
      description: 'Buttermilk-brined fried chicken, three sauces, no fuss — built for delivery as much as the counter.',
      targetAudience: 'Young professionals aged 20-35 across Dubai who order in three nights a week.',
      personality: ['Bold', 'Fast', 'Playful', 'Direct'],
      toneOfVoice: 'Short, punchy and confident, never corporate',
      visualStyle: 'High-contrast, saturated, close crops, motion',
      values: ['Brined 12 hours', 'Made to order', 'No hidden charges'],
      products: ['Signature chicken burger', 'Loaded fries', 'Wings bucket', 'Chicken tenders'],
      services: ['Delivery', 'Collection', 'Catering trays'],
      usps: ['Brined for 12 hours', 'Fried to order, never held', 'Free delivery over AED 50'],
      offers: ['Weekend wings bucket', 'Two burgers and fries'],
      keywords: ['Dubai fried chicken', 'chicken delivery', 'JLT food'],
      forbiddenWords: ['gourmet', 'artisanal'],
      ctaStyle: 'Order now',
    },
  },
  {
    key: 'noor-cafe',
    name: 'Noor Café',
    businessName: 'Noor Speciality Coffee',
    cuisine: 'Speciality café',
    location: 'Amman, Jordan',
    address: 'Jabal Al Weibdeh, Amman',
    branches: ['Weibdeh', 'Abdoun'],
    website: 'https://noorcafe.example.com',
    email: 'hi@noorcafe.example.com',
    phone: '+962 6 000 0000',
    language: Language.EN,
    objectives: ['Grow morning footfall', 'Sell more retail beans', 'Build the brunch reputation'],
    colors: { primary: '#8E6BB5', secondary: '#D9A566', accent: '#5BC0BE', background: '#120E18', text: '#F0EAF5' },
    font: 'Inter',
    brand: {
      description: 'A speciality roaster and all-day brunch kitchen in a 1930s house, roasting on site every Tuesday.',
      targetAudience: 'Remote workers and weekend brunchers aged 22-40 in west Amman who care where the beans came from.',
      personality: ['Considered', 'Warm', 'Curious', 'Unhurried'],
      toneOfVoice: 'Straightforward and knowledgeable without being precious',
      visualStyle: 'Natural light, muted warm neutrals, hands and texture',
      values: ['Direct trade beans', 'Roasted on site', 'No seat time limits'],
      products: ['Filter of the week', 'Shakshuka', 'Cardamom latte', 'Retail bean bags'],
      services: ['Dine-in', 'Retail beans', 'Subscriptions', 'Barista classes'],
      usps: ['Roasted on site every Tuesday', 'Origin printed on every bag', 'Work as long as you like'],
      offers: ['Bean subscription first bag free', 'Weekday brunch set'],
      keywords: ['Amman coffee', 'speciality coffee', 'brunch Amman'],
      forbiddenWords: ['instant', 'generic'],
      ctaStyle: 'Find us',
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
  console.log('Seeding Restaurant Marketing OS demo data…');

  // ------------------------------------------------------------ reset
  // Restaurants cascade to campaigns, content, ads, media, analytics and the
  // rest, so removing them clears almost everything the seed created.
  const seeded = await prisma.restaurant.findMany({
    where: { name: { in: RESTAURANTS.map((seed) => seed.name) } },
    select: { id: true },
  });
  if (seeded.length > 0) {
    await prisma.restaurant.deleteMany({ where: { id: { in: seeded.map((row) => row.id) } } });
    console.log(`  cleared ${seeded.length} previously seeded restaurants`);
  }
  await prisma.task.deleteMany({ where: { restaurantId: null } });
  await prisma.user.deleteMany({ where: { email: OWNER_EMAIL } });

  // ------------------------------------------------------------ workspace and owner
  const workspace = await prisma.workspace.upsert({
    where: { id: 'workspace' },
    create: { id: 'workspace', name: 'Nakhla Marketing', currency: CURRENCY, timezone: 'Asia/Riyadh' },
    update: { name: 'Nakhla Marketing', currency: CURRENCY, timezone: 'Asia/Riyadh' },
  });

  const owner = await prisma.user.create({
    data: {
      name: 'Rana Haddad',
      email: OWNER_EMAIL,
      passwordHash: await hash(DEMO_PASSWORD),
      role: Role.OWNER,
      themePref: 'dark',
    },
  });

  console.log(`  workspace "${workspace.name}" and one owner account`);

  // ------------------------------------------------------------ restaurants
  let totalSnapshots = 0;
  let totalContent = 0;
  let totalAds = 0;

  for (const [index, seed] of RESTAURANTS.entries()) {
    const random = rng(1000 + index * 97);

    const restaurant = await prisma.restaurant.create({
      data: {
        name: seed.name,
        businessName: seed.businessName,
        email: seed.email,
        phone: seed.phone,
        cuisine: seed.cuisine,
        description: seed.brand.description,
        website: seed.website,
        location: seed.location,
        address: seed.address,
        branches: seed.branches,
        marketingObjectives: seed.objectives,
        status: RestaurantStatus.ACTIVE,
        socialLinks: {
          instagram: `https://instagram.com/${seed.key}`,
          tiktok: `https://tiktok.com/@${seed.key}`,
        },
        googleBusiness: { profile: `https://business.google.com/${seed.key}`, rating: '4.6' },
        notes: `Demo restaurant. ${seed.brand.description}`,
        brand: {
          create: {
            businessName: seed.businessName,
            cuisine: seed.cuisine,
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

    // Integrations: created and visibly disconnected, because no adapter exists.
    await prisma.integration.createMany({
      data: [Platform.INSTAGRAM, Platform.TIKTOK, Platform.GOOGLE_BUSINESS, Platform.SNAPCHAT].map((platform) => ({
        restaurantId: restaurant.id,
        platform,
        status: IntegrationStatus.DISCONNECTED,
      })),
    });

    // -------------------------------------------------- campaigns
    const campaignPlan = [
      {
        name: `${seed.name} — signature dish push`,
        objective: CampaignObjective.SALES,
        status: CampaignStatus.ACTIVE,
        budget: 12000 + index * 3500,
        start: daysAgo(45),
        end: daysAhead(15),
        platforms: [Platform.INSTAGRAM, Platform.TIKTOK, Platform.SNAPCHAT],
      },
      {
        name: `${seed.name} — weekday offer`,
        objective: CampaignObjective.TRAFFIC,
        status: CampaignStatus.ACTIVE,
        budget: 6000 + index * 1200,
        start: daysAgo(30),
        end: daysAhead(30),
        platforms: [Platform.INSTAGRAM, Platform.GOOGLE_ADS],
      },
      {
        name: `${seed.name} — brand film`,
        objective: CampaignObjective.AWARENESS,
        status: CampaignStatus.COMPLETED,
        budget: 8000,
        start: daysAgo(120),
        end: daysAgo(60),
        platforms: [Platform.INSTAGRAM, Platform.TIKTOK],
      },
      {
        name: `${seed.name} — ${seed.objectives[0]?.toLowerCase() ?? 'next quarter'}`,
        objective: CampaignObjective.LEADS,
        status: CampaignStatus.PLANNING,
        budget: 9500,
        start: daysAhead(20),
        end: daysAhead(80),
        platforms: [Platform.INSTAGRAM, Platform.GOOGLE_ADS],
      },
    ];

    for (const [campaignIndex, plan] of campaignPlan.entries()) {
      const campaign = await prisma.campaign.create({
        data: {
          restaurantId: restaurant.id,
          name: plan.name,
          objective: plan.objective,
          status: plan.status,
          budget: new Prisma.Decimal(plan.budget),
          currency: CURRENCY,
          startDate: plan.start,
          endDate: plan.end,
          targetAudience: seed.brand.targetAudience,
          locations: [seed.location],
          kpi: plan.objective === CampaignObjective.SALES
            ? 'ROAS above 3.0x'
            : plan.objective === CampaignObjective.TRAFFIC
              ? `Cost per click under ${CURRENCY} 2.00`
              : 'Reach 250k unique people',
          platforms: {
            create: plan.platforms.map((platform) => ({
              platform,
              budget: new Prisma.Decimal(Math.round(plan.budget / plan.platforms.length)),
            })),
          },
        },
      });

      // ------------------------------------------ ads
      /*
       * Ads on live campaigns carry recorded figures; the planned campaign's ads
       * deliberately do not. `metricsAt: null` is the state the UI shows as
       * "not recorded", and leaving one example of it here means that path is
       * visible in the demo rather than only reachable in theory.
       */
      const hasRun = plan.status !== CampaignStatus.PLANNING;
      for (const [adIndex, platform] of plan.platforms.slice(0, 2).entries()) {
        const product = seed.brand.products[adIndex % seed.brand.products.length]!;
        const spend = hasRun ? Math.round((plan.budget / 4) * (0.7 + random() * 0.5)) : 0;
        const impressions = hasRun ? Math.round((spend / PLATFORM_PROFILE[platform]!.cpm) * 1000) : 0;
        const clicks = hasRun ? Math.round(impressions * PLATFORM_PROFILE[platform]!.ctr) : 0;
        const conversions = hasRun ? Math.round(clicks * PLATFORM_PROFILE[platform]!.cvr) : 0;

        await prisma.ad.create({
          data: {
            restaurantId: restaurant.id,
            campaignId: campaign.id,
            name: `${product} — ${platform.toLowerCase()}`,
            platform,
            objective: plan.objective,
            status: hasRun
              ? plan.status === CampaignStatus.COMPLETED ? AdStatus.COMPLETED : AdStatus.ACTIVE
              : AdStatus.DRAFT,
            headline: `${seed.brand.offers[0]} — ${product}`,
            primaryText: seed.brand.description,
            cta: seed.brand.ctaStyle,
            audience: seed.brand.targetAudience,
            budget: new Prisma.Decimal(Math.round(plan.budget / plan.platforms.length)),
            spend: new Prisma.Decimal(spend),
            impressions,
            reach: Math.round(impressions * 0.62),
            clicks,
            leads: Math.round(conversions * 1.8),
            conversions,
            revenue: new Prisma.Decimal(Math.round(conversions * PLATFORM_PROFILE[platform]!.aov)),
            metricsAt: hasRun ? daysAgo(1) : null,
            startDate: plan.start,
            endDate: plan.end,
          },
        });
        totalAds += 1;
      }

      // ------------------------------------------ analytics
      // Only campaigns that have actually run get snapshots.
      if (plan.status === CampaignStatus.PLANNING) continue;

      const firstDay = Math.min(90, Math.round((Date.now() - plan.start.getTime()) / 86400000));
      const lastDay = Math.max(0, Math.round((Date.now() - Math.min(plan.end.getTime(), Date.now())) / 86400000));

      const rows: Prisma.AnalyticsSnapshotCreateManyInput[] = [];
      let spent = 0;

      for (let day = firstDay; day >= lastDay; day -= 1) {
        const date = daysAgo(day);
        // Thursday and Friday run hotter for restaurants in the Gulf.
        const weekend = [4, 5].includes(date.getUTCDay()) ? 1.28 : 1;
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
          // Leads run ahead of conversions: an enquiry or a booking request is
          // cheaper to earn than a completed order.
          const leads = Math.round(conversions * (1.4 + random() * 0.9));
          const revenue = conversions * profile.aov * (0.85 + random() * 0.4);
          const engagements = Math.round(impressions * (0.012 + random() * 0.02));

          spent += spend;
          rows.push({
            restaurantId: restaurant.id,
            campaignId: campaign.id,
            platform,
            date,
            spend: new Prisma.Decimal(spend.toFixed(2)),
            reach,
            impressions,
            clicks,
            leads,
            conversions,
            revenue: new Prisma.Decimal(revenue.toFixed(2)),
            engagements,
          });
        }
      }

      if (rows.length > 0) {
        // The daily generator drifts above plan, which would leave every campaign
        // looking overspent. Normalise to a believable share of budget instead —
        // and leave the first campaign of each restaurant hot, so the budget
        // alert has something real to fire on.
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
        { status: ContentStatus.READY, type: ContentType.STORY, platform: Platform.SNAPCHAT, offsetDays: 5 },
        { status: ContentStatus.DRAFT, type: ContentType.AD_CREATIVE, platform: Platform.INSTAGRAM, offsetDays: 8 },
        { status: ContentStatus.IDEA, type: ContentType.REEL, platform: Platform.TIKTOK, offsetDays: 12 },
      ];

      // Only the two live campaigns carry a full content set.
      const wanted = campaignIndex < 2 ? contentPlan : contentPlan.slice(0, 2);

      for (const [contentIndex, item] of wanted.entries()) {
        const language = seed.language;
        const isArabic = language === Language.AR;
        const offer = seed.brand.offers[contentIndex % seed.brand.offers.length]!;
        const product = seed.brand.products[contentIndex % seed.brand.products.length]!;

        const headline = isArabic
          ? `${offer} على ${product} من ${seed.businessName}`
          : `${offer} on ${product} at ${seed.businessName}`;
        const caption = `${headline}\n${seed.brand.description}\n${seed.brand.ctaStyle} 👇`;

        // Only work that has actually gone out or is booked in carries a date.
        const scheduled = ([ContentStatus.SCHEDULED, ContentStatus.PUBLISHED] as ContentStatus[]).includes(item.status)
          ? daysAhead(item.offsetDays)
          : null;

        const content = await prisma.content.create({
          data: {
            restaurantId: restaurant.id,
            campaignId: campaign.id,
            authorId: owner.id,
            name: `${plan.name} — ${item.type.toLowerCase()} ${contentIndex + 1}`,
            type: item.type,
            status: item.status,
            platform: item.platform,
            language,
            tone: seed.brand.toneOfVoice,
            productService: product,
            offer,
            audience: seed.brand.targetAudience,
            brief: `Push ${product} for ${seed.name}. Lead with the offer, keep it appetite-led.`,
            headline,
            caption,
            primaryText: caption,
            shortText: `${offer} — ${product}`,
            longText: `${seed.businessName}\n\n${seed.brand.description}\n\n${seed.brand.usps.map((u) => `• ${u}`).join('\n')}\n\n${seed.brand.ctaStyle}.`,
            slogan: `${seed.businessName} — ${seed.brand.usps[0]}`,
            cta: seed.brand.ctaStyle,
            aiGenerated: contentIndex % 2 === 0,
            timezone: 'Asia/Riyadh',
            scheduledAt: scheduled,
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

        if (scheduled) {
          await prisma.calendarEvent.create({
            data: {
              contentId: content.id,
              restaurantId: restaurant.id,
              title: content.name,
              platform: content.platform,
              startAt: scheduled,
              timezone: 'Asia/Riyadh',
            },
          });
        }
      }
    }

    // -------------------------------------------------- tasks
    await prisma.task.createMany({
      data: [
        {
          restaurantId: restaurant.id,
          assigneeId: owner.id,
          title: `Send the monthly report to ${seed.name}`,
          details: 'Generate from the Reports tab, then export as PDF for the owner.',
          status: TaskStatus.TODO,
          priority: TaskPriority.HIGH,
          dueAt: daysAhead(3 + index),
        },
        {
          restaurantId: restaurant.id,
          assigneeId: owner.id,
          title: `Shoot new photography for ${seed.brand.products[0]}`,
          status: index === 0 ? TaskStatus.IN_PROGRESS : TaskStatus.TODO,
          priority: TaskPriority.MEDIUM,
          dueAt: daysAhead(10 + index * 2),
        },
        // One overdue task per restaurant, so the dashboard alert is live.
        {
          restaurantId: restaurant.id,
          assigneeId: owner.id,
          title: `Record last week's ad figures for ${seed.name}`,
          details: 'Copy spend, impressions and conversions from each platform into the Ads tab.',
          status: TaskStatus.TODO,
          priority: TaskPriority.URGENT,
          dueAt: daysAgo(2),
        },
      ],
    });

    console.log(`  restaurant ${index + 1}/${RESTAURANTS.length}: ${seed.name}`);
  }

  // ------------------------------------------------------------ workspace tasks
  await prisma.task.createMany({
    data: [
      {
        assigneeId: owner.id,
        title: 'Renew the stock photography subscription',
        status: TaskStatus.TODO,
        priority: TaskPriority.LOW,
        dueAt: daysAhead(21),
      },
      {
        assigneeId: owner.id,
        title: 'Review Q4 retainer pricing',
        status: TaskStatus.TODO,
        priority: TaskPriority.MEDIUM,
        dueAt: daysAhead(14),
      },
    ],
  });

  // ------------------------------------------------------------ notifications
  await prisma.notification.createMany({
    data: [
      {
        userId: owner.id,
        type: NotificationType.TASK_DUE,
        title: 'Ad figures are overdue for every restaurant',
        body: 'Nothing is fetched automatically — record last week\'s numbers to keep reporting accurate.',
        link: '/tasks',
      },
      {
        userId: owner.id,
        type: NotificationType.AI_ALERT,
        title: 'Run the AI analyst on this month',
        body: 'Thirty days of data are in. Ask for an analysis before the next client call.',
        link: '/analytics',
      },
    ],
  });

  // ------------------------------------------------------------ one saved report
  const firstRestaurant = await prisma.restaurant.findFirst({
    where: { name: RESTAURANTS[0]!.name },
    select: { id: true, name: true, businessName: true, logoUrl: true },
  });

  if (firstRestaurant) {
    await prisma.report.create({
      data: {
        restaurantId: firstRestaurant.id,
        type: ReportType.MONTHLY,
        title: `${firstRestaurant.name} — last 30 days`,
        periodStart: daysAgo(30),
        periodEnd: new Date(),
        payload: {
          note: 'Seeded placeholder. Regenerate from the Reports page to compute figures from live data.',
          restaurant: {
            id: firstRestaurant.id,
            name: firstRestaurant.name,
            businessName: firstRestaurant.businessName,
          },
          currency: CURRENCY,
          period: { from: daysAgo(30).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) },
          totals: {}, changes: {}, platforms: [], campaigns: [], series: [], ads: [], topContent: [],
          analysis: null, aiMeta: null, generatedAt: new Date().toISOString(),
        } as Prisma.InputJsonValue,
      },
    });
  }

  console.log('\nDone.');
  console.table({
    restaurants: await prisma.restaurant.count(),
    campaigns: await prisma.campaign.count(),
    ads: totalAds,
    content: totalContent,
    tasks: await prisma.task.count(),
    snapshots: totalSnapshots,
  });
  console.log(`
Sign in with:

  ${OWNER_EMAIL}
  ${DEMO_PASSWORD}

This is demo data. On a real deployment, create the account with:

  npm run owner:create -- --email you@example.com --name "Your Name"
`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
