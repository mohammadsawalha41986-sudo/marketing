/**
 * Local generator — the provider used when no OPENAI_API_KEY is configured.
 *
 * It is deterministic and template-driven, in Arabic and English. It exists so
 * the product is fully usable (and demonstrable, and testable) without a paid
 * key, and every result it returns is flagged `isFallback` so the UI can label
 * it honestly rather than passing it off as model output.
 *
 * For campaign analysis it computes real deltas from the metrics it is handed
 * and phrases them. It never invents a figure.
 */

import type { Language } from '@prisma/client';
import type { BrandContext, ContentRequest } from './context.js';
import { platformRule } from './context.js';
import type { Analysis, GeneratedCopy } from './schemas.js';
import type { CampaignFacts } from './facts.js';

const AR = {
  discover: 'اكتشف',
  now: 'الآن',
  bookNow: 'احجز الآن',
  orderNow: 'اطلب الآن',
  shopNow: 'تسوق الآن',
  learnMore: 'اعرف المزيد',
  contactUs: 'تواصل معنا',
  from: 'من',
  forYou: 'لك',
  in: 'في',
};

function pick<T>(items: T[], seed: number): T | undefined {
  if (items.length === 0) return undefined;
  return items[seed % items.length];
}

/** Stable pseudo-randomness: the same request always yields the same copy. */
function seedOf(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return hash;
}

function ctaFor(language: Language, brand: BrandContext, seed: number): string {
  if (brand.ctaStyle && brand.ctaStyle.trim().length > 0) return brand.ctaStyle.trim();
  const en = ['Book now', 'Order now', 'Shop the collection', 'Learn more', 'Get in touch', 'Reserve your table'];
  const ar = [AR.bookNow, AR.orderNow, AR.shopNow, AR.learnMore, AR.contactUs];
  return (language === 'AR' ? pick(ar, seed) : pick(en, seed)) ?? 'Learn more';
}

function subject(brand: BrandContext, request: ContentRequest, seed: number): string {
  return (
    request.productService?.trim() ||
    pick(brand.products, seed) ||
    pick(brand.services, seed) ||
    brand.businessType ||
    brand.businessName
  );
}

function tagify(value: string): string {
  const cleaned = value
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .trim()
    .split(/\s+/)
    .slice(0, 4)
    .map((word, index) => (index === 0 ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()))
    .join('');
  return cleaned.length > 1 ? `#${cleaned}` : '';
}

export function templateHashtags(brand: BrandContext, request: ContentRequest, limit: number): string[] {
  const seeds = [
    brand.businessName,
    brand.businessType ?? '',
    brand.industry ?? '',
    brand.location ?? '',
    request.productService ?? '',
    request.offer ?? '',
    ...brand.keywords,
    ...brand.products.slice(0, 4),
    ...brand.services.slice(0, 4),
    ...brand.values.slice(0, 3),
  ];

  const tags = new Set<string>();
  for (const seed of seeds) {
    if (!seed || seed.trim().length === 0) continue;
    const tag = tagify(seed);
    if (tag) tags.add(tag);
    if (tags.size >= limit) break;
  }
  return [...tags].slice(0, limit);
}

export function templateCopy(brand: BrandContext, request: ContentRequest): GeneratedCopy {
  const rule = platformRule(request.platform);
  const seed = seedOf(`${brand.businessName}|${request.platform}|${request.productService ?? ''}|${request.offer ?? ''}|${request.language}`);
  const topic = subject(brand, request, seed);
  const usp = pick(brand.usps, seed) ?? pick(brand.values, seed) ?? '';
  const offer = request.offer?.trim() ?? pick(brand.offers, seed) ?? '';
  const audience = request.audience?.trim() || brand.targetAudience || '';
  const place = brand.location ?? '';
  const cta = ctaFor(request.language, brand, seed);
  const tone = request.tone || brand.toneOfVoice || (request.language === 'AR' ? 'ودّي' : 'confident');

  if (request.language === 'AR') {
    const headline = offer
      ? `${offer} على ${topic} من ${brand.businessName}`
      : `${AR.discover} ${topic} من ${brand.businessName}`;
    const slogan = usp ? `${brand.businessName} — ${usp}` : `${brand.businessName} ${AR.forYou}`;
    const caption = [
      headline,
      brand.description ? brand.description : '',
      usp ? `• ${usp}` : '',
      place ? `${AR.in} ${place}` : '',
      `${cta} 👇`,
    ]
      .filter(Boolean)
      .join('\n')
      .slice(0, rule.captionMax);

    const primaryText = [
      `${AR.discover} ${topic} ${AR.now} من ${brand.businessName}.`,
      audience ? `مصمّم خصيصاً لـ${audience}.` : '',
      usp ? `ما يميزنا: ${usp}.` : '',
      offer ? `العرض: ${offer}.` : '',
      `${cta}.`,
    ]
      .filter(Boolean)
      .join(' ');

    const longText = [
      `${brand.businessName}${place ? ` ${AR.in} ${place}` : ''}`,
      '',
      brand.description ?? '',
      '',
      brand.usps.length > 0 ? 'لماذا نحن:' : '',
      ...brand.usps.slice(0, 4).map((item) => `• ${item}`),
      '',
      offer ? `العرض الحالي: ${offer}` : '',
      '',
      `${cta}.`,
    ]
      .filter((line) => line !== undefined)
      .join('\n')
      .trim();

    return {
      headline: headline.slice(0, 160),
      caption,
      primaryText: primaryText.slice(0, 3000),
      shortText: (offer ? `${offer} — ${topic}` : `${topic} من ${brand.businessName}`).slice(0, 300),
      longText: longText.slice(0, 6000),
      slogan: slogan.slice(0, 120),
      cta: cta.slice(0, 80),
      hashtags: templateHashtags(brand, request, rule.hashtags),
      keywords: [topic, brand.businessType ?? '', brand.industry ?? '', ...brand.keywords].filter(Boolean).slice(0, 12),
    };
  }

  const headline = offer ? `${offer} on ${topic} at ${brand.businessName}` : `${topic}, done properly at ${brand.businessName}`;
  const slogan = usp ? `${brand.businessName} — ${usp}` : `${brand.businessName}. ${topic} you can count on.`;

  const caption = [
    headline,
    brand.description ?? '',
    usp ? `Why us: ${usp}` : '',
    place ? `📍 ${place}` : '',
    `${cta} 👇`,
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, rule.captionMax);

  const primaryText = [
    `${headline}.`,
    audience ? `Made for ${audience}.` : '',
    usp ? `What sets us apart: ${usp}.` : '',
    offer ? `Right now: ${offer}.` : '',
    `${cta}.`,
  ]
    .filter(Boolean)
    .join(' ');

  const longText = [
    `${brand.businessName}${place ? ` — ${place}` : ''}`,
    '',
    brand.description ?? '',
    '',
    brand.usps.length > 0 ? 'Why people choose us:' : '',
    ...brand.usps.slice(0, 4).map((item) => `• ${item}`),
    '',
    offer ? `Current offer: ${offer}` : '',
    '',
    `${cta}.`,
    '',
    `Tone: ${tone}. ${rule.note}`,
  ]
    .join('\n')
    .trim();

  return {
    headline: headline.slice(0, 160),
    caption,
    primaryText: primaryText.slice(0, 3000),
    shortText: (offer ? `${offer} — ${topic}` : `${topic} at ${brand.businessName}`).slice(0, 300),
    longText: longText.slice(0, 6000),
    slogan: slogan.slice(0, 120),
    cta: cta.slice(0, 80),
    hashtags: templateHashtags(brand, request, rule.hashtags),
    keywords: [topic, brand.businessType ?? '', brand.industry ?? '', ...brand.keywords].filter(Boolean).slice(0, 12),
  };
}

// ------------------------------------------------------------------ analysis

const money = (value: number) => `$${Math.round(value).toLocaleString('en-US')}`;
const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

/**
 * Phrases the figures it is given. Every number in the output is copied from
 * `facts`, which the caller computed from AnalyticsSnapshot rows — nothing here
 * estimates, extrapolates or invents.
 */
export function templateAnalysis(facts: CampaignFacts): Analysis {
  const working: string[] = [];
  const failing: string[] = [];
  const recommendations: Analysis['recommendations'] = [];
  const nextActions: string[] = [];

  /*
   * Only platforms with a measurable return can be ranked by it.
   *
   * A platform whose ROAS is unavailable is not the worst performer — it is
   * unmeasured, and sorting it to the bottom would produce the analyst's most
   * confident sentence about its least reliable input.
   */
  const measurable = facts.platforms.filter(
    (platform): platform is typeof platform & { roas: number } => platform.roas !== null,
  );
  const best = measurable.filter((p) => p.conversions > 0).sort((a, b) => b.roas - a.roas)[0];
  const worst = [...measurable].sort((a, b) => a.roas - b.roas)[0];
  const unmeasured = facts.platforms.filter((platform) => platform.roas === null && platform.spend > 0);

  if (best) working.push(`${best.label} has the strongest return at ${best.roas.toFixed(2)}x ROAS on ${money(best.spend)} of spend.`);
  if (facts.ctrTrend > 0.05) working.push(`Click-through rate is up ${pct(facts.ctrTrend)} against the previous period.`);
  if (facts.conversionTrend > 0.05) working.push(`Conversions are up ${pct(facts.conversionTrend)} period over period.`);
  if (facts.totals.roas !== null && facts.totals.roas >= 1) {
    working.push(`Overall ROAS is ${facts.totals.roas.toFixed(2)}x, above break-even.`);
  }

  /*
   * Spend with no attributed revenue is a finding in its own right, and the
   * honest one: it is almost always a tracking gap rather than a campaign that
   * genuinely returned nothing, and saying "0.00x ROAS" would assert the latter.
   */
  for (const platform of unmeasured) {
    failing.push(
      `${platform.label} has ${money(platform.spend)} of spend with no revenue attributed to it, ` +
        `so its return cannot be measured. ${facts.totals.reasons?.roas ?? 'Check that conversion tracking is configured.'}`,
    );
  }

  if (worst && measurable.length > 1 && worst.roas < 1) {
    failing.push(`${worst.label} is below break-even at ${worst.roas.toFixed(2)}x ROAS on ${money(worst.spend)}.`);
  }
  if (facts.ctrTrend < -0.05) failing.push(`Click-through rate has fallen ${pct(Math.abs(facts.ctrTrend))} against the previous period.`);
  if (facts.conversionTrend < -0.05) failing.push(`Conversions are down ${pct(Math.abs(facts.conversionTrend))} period over period.`);
  if (facts.budgetUsed > 0.9 && facts.daysRemaining > 3) {
    failing.push(`${pct(facts.budgetUsed)} of budget is spent with ${facts.daysRemaining} days still to run.`);
  }

  if (best && worst && best.label !== worst.label && worst.roas < best.roas * 0.6) {
    recommendations.push({
      title: `Shift budget from ${worst.label} towards ${best.label}`,
      detail: `${best.label} is returning ${best.roas.toFixed(2)}x against ${worst.roas.toFixed(2)}x on ${worst.label}. Moving a portion of the remaining budget is the highest-leverage change available this period.`,
      impact: 'high',
      area: 'budget',
    });
  }
  if (facts.ctrTrend < -0.05) {
    recommendations.push({
      title: 'Refresh the creative',
      detail: 'A falling click-through rate on steady impressions is the usual signature of creative fatigue. Rotate the primary asset and the hook before adding budget.',
      impact: 'medium',
      area: 'creative',
    });
  }
  if (facts.totals.clicks > 100 && facts.totals.conversions === 0) {
    recommendations.push({
      title: 'Check conversion tracking',
      detail: `The campaign has ${facts.totals.clicks.toLocaleString('en-US')} clicks and no recorded conversions. Verify the tracking setup before drawing conclusions about performance.`,
      impact: 'high',
      area: 'measurement',
    });
  }
  if (facts.budgetUsed > 0.9 && facts.daysRemaining > 3) {
    recommendations.push({
      title: 'Reset pacing for the days remaining',
      detail: `At ${pct(facts.budgetUsed)} of budget with ${facts.daysRemaining} days left, the campaign will go dark before it ends unless the daily cap is lowered or the budget is topped up.`,
      impact: 'high',
      area: 'budget',
    });
  }

  if (recommendations.length === 0) {
    recommendations.push({
      title: 'Hold the current setup',
      detail: 'Nothing in this period is far enough from plan to justify a change. Re-check after the next full week of data.',
      impact: 'low',
      area: 'measurement',
    });
  }

  nextActions.push('Review the recommendations above and apply the ones you agree with.');
  if (best) nextActions.push(`Confirm ${best.label} can absorb more budget before shifting any.`);
  if (facts.daysRemaining <= 7 && facts.daysRemaining > 0) nextActions.push(`Prepare the end-of-campaign report — ${facts.daysRemaining} days remain.`);

  const summary =
    facts.totals.spend === 0
      ? 'No spend has been recorded for this period yet, so there is nothing to analyse.'
      : `Across ${facts.periodDays} days the campaigns spent ${money(facts.totals.spend)}, reached ${facts.totals.reach.toLocaleString('en-US')} people and recorded ${facts.totals.conversions.toLocaleString('en-US')} conversions` +
        (facts.totals.roas === null
          ? `. Return on ad spend cannot be calculated: ${(facts.totals.reasons?.roas ?? 'revenue is not being measured').toLowerCase()}.`
          : ` at ${facts.totals.roas.toFixed(2)}x ROAS.`);

  return { summary, working, failing, recommendations, nextActions };
}
