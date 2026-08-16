/**
 * Product → platform ad copy.
 *
 * Every platform gets the fields its ad manager actually asks for — Facebook
 * wants primary text, headline and description; Google wants short headlines
 * under 30 characters; TikTok wants a hook. Emitting one blob of text and
 * calling it "the copy" leaves the operator retyping it into six different
 * boxes with six different limits.
 *
 * The constraint that governs everything here: **copy is assembled only from
 * fields the product actually has.** No price appears unless the product has a
 * price. No discount is mentioned unless there is a real sale price below a real
 * list price. Nothing invents a rating, a review count, a guarantee, a
 * certification, a delivery time or a health claim — the generator has no way to
 * produce those strings, which is stronger than instructing a model not to.
 *
 * Text is composed rather than generated, so the result is deterministic and
 * fully attributable to a source field. When a language model is configured it
 * can rewrite this copy afterwards; what it cannot do is introduce a fact the
 * product does not contain, because the review screen shows the operator which
 * field each claim came from.
 */

import { Platform } from '@prisma/client';

export interface ProductForCopy {
  name: string;
  brand?: string | null;
  description?: string | null;
  price?: number | null;
  salePrice?: number | null;
  currency?: string | null;
  category?: string | null;
  features: string[];
}

export interface CopyField {
  label: string;
  value: string;
  /** Ad-manager limit, so the UI can show remaining characters. */
  maxLength: number;
  /** Which product fields this string was built from. */
  from: string[];
}

export interface PlatformCopy {
  platform: Platform;
  fields: CopyField[];
  hashtags: string[];
  /** Claims deliberately not made, and why. Shown so absence is legible. */
  omitted: string[];
}

/** Trim to a limit at a word boundary, never mid-word. */
function fit(text: string, limit: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= limit) return clean;

  const cut = clean.slice(0, limit - 1);
  const boundary = cut.lastIndexOf(' ');
  return `${(boundary > limit * 0.6 ? cut.slice(0, boundary) : cut).replace(/[\s.,;:]+$/, '')}…`;
}

/**
 * Format money the way the merchant stated it.
 *
 * Falls back to `<amount> <code>` for currencies Intl cannot render, rather than
 * dropping the currency and leaving a bare number in an advertisement.
 */
function money(amount: number, currency: string | null | undefined): string {
  if (!currency) return String(amount);
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

/** The offer clause — present only when the product genuinely carries one. */
function offerClause(product: ProductForCopy): { text: string | null; from: string[] } {
  const { price, salePrice, currency } = product;

  if (typeof salePrice === 'number' && typeof price === 'number' && salePrice < price) {
    const saved = Math.round(((price - salePrice) / price) * 100);
    return {
      text: `${money(salePrice, currency)} (was ${money(price, currency)}, save ${saved}%)`,
      from: ['price', 'salePrice', 'currency'],
    };
  }
  if (typeof price === 'number') return { text: money(price, currency), from: ['price', 'currency'] };
  return { text: null, from: [] };
}

/** The single best product statement available, without embellishment. */
function benefit(product: ProductForCopy): { text: string | null; from: string[] } {
  const feature = product.features.find((item) => item.length >= 12);
  if (feature) return { text: feature, from: ['features'] };
  if (product.description) return { text: product.description, from: ['description'] };
  return { text: null, from: [] };
}

function hashtagsFor(product: ProductForCopy, limit: number): string[] {
  const tagify = (value: string): string | null => {
    const cleaned = value
      .normalize('NFKD')
      .replace(/[^\p{L}\p{N}\s]/gu, '')
      .trim()
      .split(/\s+/)
      .slice(0, 3)
      .map((word, index) => (index === 0 ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()))
      .join('');
    return cleaned.length > 2 ? `#${cleaned}` : null;
  };

  // Built from the product's own words only — no trending-tag list, because a
  // popular tag unrelated to the product is spam, not reach.
  const sources = [product.name, product.brand ?? '', product.category ?? '', ...product.features.slice(0, 3)];

  return [...new Set(sources.map(tagify).filter((tag): tag is string => Boolean(tag)))].slice(0, limit);
}

/** What was left out, so the operator can see the gap and fill it. */
function omissions(product: ProductForCopy): string[] {
  const notes: string[] = [];
  if (typeof product.price !== 'number') notes.push('No price stated — the page did not publish one, so none is claimed.');
  if (!product.description && product.features.length === 0) {
    notes.push('No description or features found, so the copy names the product without describing it.');
  }
  if (!product.brand) notes.push('No brand stated, so the copy does not attribute the product to one.');
  return notes;
}

function cta(product: ProductForCopy): string {
  // Deliberately generic. "Order now — free delivery" would be a promise the
  // product data does not support.
  return product.category?.toLowerCase().includes('service') ? 'Learn more' : 'Shop now';
}

export function generateCopy(product: ProductForCopy, platform: Platform): PlatformCopy {
  const offer = offerClause(product);
  const value = benefit(product);
  const brandPrefix = product.brand ? `${product.brand} ` : '';
  const action = cta(product);

  const nameFrom = ['name'];
  const headlineBase = `${brandPrefix}${product.name}`.trim();

  const field = (label: string, value: string, maxLength: number, from: string[]): CopyField => ({
    label,
    value: fit(value, maxLength),
    maxLength,
    from,
  });

  const shared = { hashtags: hashtagsFor(product, platform === Platform.TIKTOK ? 6 : 8), omitted: omissions(product) };

  switch (platform) {
    case Platform.INSTAGRAM: {
      const caption = [product.name, value.text, offer.text].filter(Boolean).join('\n\n');
      return {
        platform,
        fields: [
          field('Headline', headlineBase, 40, [...nameFrom, ...(product.brand ? ['brand'] : [])]),
          field('Caption', caption, 2200, [...nameFrom, ...value.from, ...offer.from]),
          field('CTA', action, 30, ['category']),
        ],
        ...shared,
      };
    }

    case Platform.FACEBOOK: {
      const primary = [value.text ?? product.name, offer.text].filter(Boolean).join(' ');
      return {
        platform,
        fields: [
          field('Primary text', primary, 125, [...value.from, ...offer.from]),
          field('Headline', headlineBase, 40, nameFrom),
          field('Description', value.text ?? product.name, 30, value.from.length ? value.from : nameFrom),
          field('CTA', action, 20, ['category']),
        ],
        ...shared,
      };
    }

    case Platform.TIKTOK: {
      // A hook is a question about the product, not a claim about it.
      const hook = product.category
        ? `Looking for ${product.category.toLowerCase()}?`
        : `Have you seen ${product.name}?`;
      return {
        platform,
        fields: [
          field('Hook', hook, 60, ['category', ...nameFrom]),
          field('Caption', [product.name, value.text].filter(Boolean).join(' — '), 150, [...nameFrom, ...value.from]),
          field('CTA', action, 20, ['category']),
        ],
        ...shared,
      };
    }

    case Platform.GOOGLE_ADS: {
      /*
       * Google's limits are the tightest in advertising: 30 characters a
       * headline. Three variations are produced because Google rotates them,
       * and each is a different true statement rather than the same sentence
       * padded differently.
       */
      const variations = [
        product.name,
        product.brand ? `${product.brand} ${product.name}` : (product.category ?? product.name),
        offer.text ? `${product.name} — ${offer.text}` : (value.text ?? product.name),
      ];

      return {
        platform,
        fields: [
          field('Headline 1', variations[0]!, 30, nameFrom),
          field('Headline 2', variations[1]!, 30, ['brand', 'category']),
          field('Headline 3', variations[2]!, 30, [...nameFrom, ...offer.from]),
          field('Long headline', headlineBase, 90, nameFrom),
          field('Description', value.text ?? product.name, 90, value.from.length ? value.from : nameFrom),
          field('CTA', action, 20, ['category']),
        ],
        hashtags: [],
        omitted: shared.omitted,
      };
    }

    case Platform.LINKEDIN: {
      const intro = [value.text ?? product.name, offer.text].filter(Boolean).join(' ');
      return {
        platform,
        fields: [
          field('Intro', intro, 150, [...value.from, ...offer.from]),
          field('Headline', headlineBase, 70, nameFrom),
          field('CTA', action, 20, ['category']),
        ],
        hashtags: hashtagsFor(product, 3),
        omitted: shared.omitted,
      };
    }

    case Platform.X: {
      const post = [product.name, value.text, offer.text].filter(Boolean).join(' — ');
      return {
        platform,
        fields: [
          field('Post', post, 280, [...nameFrom, ...value.from, ...offer.from]),
          field('CTA', action, 20, ['category']),
        ],
        hashtags: hashtagsFor(product, 3),
        omitted: shared.omitted,
      };
    }

    default: {
      // SNAPCHAT and GOOGLE_BUSINESS: a short, honest default rather than a
      // pretence of platform-specific shaping that has not been designed yet.
      const caption = [product.name, value.text, offer.text].filter(Boolean).join(' — ');
      return {
        platform,
        fields: [
          field('Headline', headlineBase, 40, nameFrom),
          field('Caption', caption, 250, [...nameFrom, ...value.from, ...offer.from]),
          field('CTA', action, 20, ['category']),
        ],
        ...shared,
      };
    }
  }
}

/** Copy for every platform the pipeline can target. */
export function generateAllCopy(product: ProductForCopy): PlatformCopy[] {
  return [
    Platform.INSTAGRAM,
    Platform.FACEBOOK,
    Platform.TIKTOK,
    Platform.GOOGLE_ADS,
    Platform.LINKEDIN,
    Platform.X,
  ].map((platform) => generateCopy(product, platform));
}
