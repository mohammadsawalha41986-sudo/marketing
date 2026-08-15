/**
 * Bounded context construction.
 *
 * The AI service never queries the database itself and never receives a
 * connection. A caller assembles exactly these fields — brand DNA plus the one
 * content request — and nothing else crosses the boundary.
 */

import type { Brand, Language, Platform } from '@prisma/client';

export interface BrandContext {
  businessName: string;
  cuisine?: string | null;
  description?: string | null;
  targetAudience?: string | null;
  location?: string | null;
  personality: string[];
  toneOfVoice?: string | null;
  values: string[];
  products: string[];
  services: string[];
  usps: string[];
  offers: string[];
  keywords: string[];
  forbiddenWords: string[];
  ctaStyle?: string | null;
  visualStyle?: string | null;
}

export interface ContentRequest {
  platform: Platform;
  contentType: string;
  language: Language;
  tone?: string | null;
  productService?: string | null;
  offer?: string | null;
  audience?: string | null;
  adName?: string | null;
}

export function brandContext(brand: Brand): BrandContext {
  return {
    businessName: brand.businessName,
    cuisine: brand.cuisine,
    description: brand.description,
    targetAudience: brand.targetAudience,
    location: brand.location,
    personality: brand.personality,
    toneOfVoice: brand.toneOfVoice,
    values: brand.values,
    products: brand.products,
    services: brand.services,
    usps: brand.usps,
    offers: brand.offers,
    keywords: brand.keywords,
    forbiddenWords: brand.forbiddenWords,
    ctaStyle: brand.ctaStyle,
    visualStyle: brand.visualStyle,
  };
}

/** Per-platform copy constraints, applied by both providers. */
export const PLATFORM_RULES: Record<string, { captionMax: number; hashtags: number; note: string }> = {
  INSTAGRAM: { captionMax: 2200, hashtags: 12, note: 'Visual-first. Hook in the first line before the fold.' },
  FACEBOOK: { captionMax: 1200, hashtags: 5, note: 'Conversational. Longer copy is acceptable.' },
  TIKTOK: { captionMax: 300, hashtags: 8, note: 'Short, punchy, native to the platform. No corporate tone.' },
  SNAPCHAT: { captionMax: 250, hashtags: 5, note: 'Immediate and casual. Vertical creative.' },
  GOOGLE_ADS: { captionMax: 90, hashtags: 0, note: 'Headline under 30 characters, description under 90. No hashtags.' },
  GOOGLE_BUSINESS: { captionMax: 1500, hashtags: 3, note: 'Local intent. Include location and opening hours where relevant.' },
  X: { captionMax: 280, hashtags: 3, note: 'One idea, under 280 characters.' },
  LINKEDIN: { captionMax: 1800, hashtags: 5, note: 'Professional register. Lead with the business outcome.' },
};

export function platformRule(platform: Platform) {
  return PLATFORM_RULES[platform] ?? { captionMax: 1200, hashtags: 8, note: 'General social copy.' };
}

/** Words the brand has banned, checked against generated output. */
export function findForbidden(text: string, forbidden: string[]): string[] {
  const haystack = text.toLowerCase();
  return forbidden.filter((word) => word.trim().length > 0 && haystack.includes(word.toLowerCase()));
}
