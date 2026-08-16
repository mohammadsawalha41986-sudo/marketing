/**
 * Turning a product page into an advertisable product.
 *
 * The governing rule is that **nothing is invented**. A field the page does not
 * state comes back absent, with a note saying so — never guessed from the URL
 * slug, never inferred from a nearby heading, never filled with a plausible
 * default. This matters more here than almost anywhere else in the product: the
 * output of this file becomes ad copy, and ad copy carries a price, a discount
 * and a claim about what somebody is selling. A fabricated price is not a
 * cosmetic bug, it is a false advertisement.
 *
 * Sources are tried in order of how much they can be trusted:
 *
 *   1. JSON-LD schema.org Product — the merchant's own machine-readable claim
 *   2. microdata (itemprop) — the same claim, in attributes
 *   3. OpenGraph / Twitter cards — meant for sharing, so usually accurate but
 *      coarser (og:title is often the page title, not the product name)
 *   4. plain HTML metadata and <title> — last resort, weakest signal
 *
 * Every field records which of those it came from, so the operator reviewing the
 * import can see what is a merchant statement and what is a page heading.
 */

export type FieldSource = 'json-ld' | 'microdata' | 'opengraph' | 'twitter' | 'html' | 'url';

export interface ExtractedField<T> {
  value: T;
  source: FieldSource;
}

export interface ExtractedProduct {
  name: ExtractedField<string> | null;
  brand: ExtractedField<string> | null;
  description: ExtractedField<string> | null;
  price: ExtractedField<number> | null;
  salePrice: ExtractedField<number> | null;
  currency: ExtractedField<string> | null;
  sku: ExtractedField<string> | null;
  category: ExtractedField<string> | null;
  availability: ExtractedField<string> | null;
  mainImage: ExtractedField<string> | null;
  galleryImages: string[];
  videoUrl: ExtractedField<string> | null;
  features: string[];
  /** Fields the page did not state, so the UI can ask rather than assume. */
  missing: string[];
}

/** Decode the HTML entities that actually appear in product markup. */
function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}

function clean(value: unknown): string | null {
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string') return null;
  const text = decodeEntities(value).replace(/\s+/g, ' ').trim();
  return text.length > 0 ? text.slice(0, 4000) : null;
}

/**
 * Parse a price without ever rounding a currency into existence.
 *
 * Returns null for anything ambiguous. A price that cannot be read confidently
 * must stay absent — showing the wrong number is worse than showing none, and
 * the operator can type it in.
 */
function parsePrice(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== 'string') return null;

  const text = value.replace(/[\s\u00a0\u202f\u2007]/g, '');
  // Strip currency symbols and codes, keep digits and separators.
  const numeric = text.replace(/[^\d.,-]/g, '');
  if (!numeric) return null;

  /*
   * Decide which separator is decimal. "1,234.56" and "1.234,56" are the same
   * amount written two ways, and reading the second as 1.234 would understate a
   * price by three orders of magnitude.
   */
  const lastComma = numeric.lastIndexOf(',');
  const lastDot = numeric.lastIndexOf('.');

  let normalized: string;
  if (lastComma > lastDot) {
    normalized = numeric.replace(/\./g, '').replace(',', '.');
  } else if (lastDot > lastComma) {
    normalized = numeric.replace(/,/g, '');
  } else {
    normalized = numeric.replace(/[.,]/g, '');
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** Absolute URL, or null. Relative image paths are common in product markup. */
function absoluteUrl(value: unknown, base: string): string | null {
  const text = clean(value);
  if (!text) return null;
  try {
    const url = new URL(text, base);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ JSON-LD

/** Every JSON-LD block on the page, parsed, with malformed ones skipped. */
function jsonLdBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];
  const pattern = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

  for (const match of html.matchAll(pattern)) {
    const raw = match[1];
    if (!raw) continue;
    try {
      // A page with one broken block usually still has good ones.
      blocks.push(JSON.parse(raw.trim()));
    } catch {
      continue;
    }
  }
  return blocks;
}

function typeOf(node: Record<string, unknown>): string[] {
  const raw = node['@type'];
  if (typeof raw === 'string') return [raw.toLowerCase()];
  if (Array.isArray(raw)) return raw.filter((item): item is string => typeof item === 'string').map((t) => t.toLowerCase());
  return [];
}

/** Walk a JSON-LD graph and return the first node of the wanted type. */
function findNode(node: unknown, wanted: string, depth = 0): Record<string, unknown> | null {
  if (depth > 8 || node === null || typeof node !== 'object') return null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findNode(item, wanted, depth + 1);
      if (found) return found;
    }
    return null;
  }

  const record = node as Record<string, unknown>;
  if (typeOf(record).includes(wanted)) return record;

  for (const value of Object.values(record)) {
    const found = findNode(value, wanted, depth + 1);
    if (found) return found;
  }
  return null;
}

function nameOf(value: unknown): string | null {
  if (typeof value === 'string') return clean(value);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return clean((value as Record<string, unknown>).name);
  }
  if (Array.isArray(value)) return nameOf(value[0]);
  return null;
}

// ------------------------------------------------------------------ HTML meta

/** All `<meta>` tags as a property/name → content map. */
function metaTags(html: string): Map<string, string> {
  const found = new Map<string, string>();
  const pattern = /<meta\s+([^>]+?)\/?>/gi;

  for (const match of html.matchAll(pattern)) {
    const attrs = match[1] ?? '';
    const key =
      /(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1]?.toLowerCase() ?? null;
    const content = /content\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] ?? null;
    if (key && content !== null && !found.has(key)) found.set(key, decodeEntities(content));
  }
  return found;
}

/** `itemprop` values carried on ordinary elements rather than meta tags. */
function microdata(html: string): Map<string, string> {
  const found = new Map<string, string>();
  const pattern = /<(\w+)\s+[^>]*itemprop\s*=\s*["']([^"']+)["'][^>]*>([\s\S]{0,400}?)<\/\1>/gi;

  for (const match of html.matchAll(pattern)) {
    const key = match[2]?.toLowerCase();
    const inner = match[3];
    if (!key || found.has(key)) continue;

    const text = clean(inner?.replace(/<[^>]+>/g, ' '));
    if (text) found.set(key, text);
  }

  // Self-closing/attribute-only forms: <span itemprop="price" content="9.99"/>
  const attrPattern = /<[^>]*itemprop\s*=\s*["']([^"']+)["'][^>]*content\s*=\s*["']([^"']*)["'][^>]*>/gi;
  for (const match of html.matchAll(attrPattern)) {
    const key = match[1]?.toLowerCase();
    const value = clean(match[2]);
    if (key && value && !found.has(key)) found.set(key, value);
  }

  return found;
}

/** Bullet lists, which is where feature copy nearly always lives. */
function listItems(html: string): string[] {
  const items: string[] = [];
  for (const match of html.matchAll(/<li\b[^>]*>([\s\S]{0,300}?)<\/li>/gi)) {
    const text = clean(match[1]?.replace(/<[^>]+>/g, ' '));
    // Navigation menus are also <li>. Length is a crude but effective filter:
    // "Home" and "My account" are short, a feature bullet is a sentence.
    if (text && text.length >= 12 && text.length <= 180) items.push(text);
  }
  return [...new Set(items)].slice(0, 12);
}

// ------------------------------------------------------------------ extractor

export function extractProduct(html: string, pageUrl: string): ExtractedProduct {
  const meta = metaTags(html);
  const micro = microdata(html);
  const blocks = jsonLdBlocks(html);

  const product = (() => {
    for (const block of blocks) {
      const node = findNode(block, 'product');
      if (node) return node;
    }
    return null;
  })();

  const offer = product ? (findNode(product.offers ?? null, 'offer') ?? findNode(product.offers ?? null, 'aggregateoffer')) : null;

  /** First non-null candidate wins, and remembers where it came from. */
  function pick<T>(candidates: Array<[FieldSource, T | null | undefined]>): ExtractedField<T> | null {
    for (const [source, value] of candidates) {
      if (value !== null && value !== undefined && value !== '') return { value, source };
    }
    return null;
  }

  const name = pick<string>([
    ['json-ld', product ? clean(product.name) : null],
    ['microdata', micro.get('name') ?? null],
    ['opengraph', clean(meta.get('og:title'))],
    ['twitter', clean(meta.get('twitter:title'))],
    ['html', clean(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(html)?.[1])],
  ]);

  const brand = pick<string>([
    ['json-ld', product ? nameOf(product.brand) : null],
    ['microdata', micro.get('brand') ?? null],
    ['opengraph', clean(meta.get('og:site_name'))],
    ['html', clean(meta.get('author'))],
  ]);

  const description = pick<string>([
    ['json-ld', product ? clean(product.description) : null],
    ['microdata', micro.get('description') ?? null],
    ['opengraph', clean(meta.get('og:description'))],
    ['twitter', clean(meta.get('twitter:description'))],
    ['html', clean(meta.get('description'))],
  ]);

  /*
   * Price and sale price. schema.org has no "was/now" pair, so the convention
   * is that `price` is what is being charged; a strike-through original may
   * appear as `highPrice` on an AggregateOffer. Where both exist the lower one
   * is the sale price — but only when they genuinely differ, so a page that
   * repeats the same figure twice is not presented as a discount.
   */
  const offerPrice = parsePrice(offer?.price ?? offer?.lowPrice ?? product?.price);
  const highPrice = parsePrice(offer?.highPrice);
  const metaPrice = parsePrice(meta.get('product:price:amount') ?? meta.get('og:price:amount'));
  const microPrice = parsePrice(micro.get('price'));

  const listed = highPrice !== null && offerPrice !== null && highPrice > offerPrice ? highPrice : null;

  const price = pick<number>([
    ['json-ld', listed ?? offerPrice],
    ['microdata', microPrice],
    ['opengraph', metaPrice],
  ]);

  const salePrice = listed !== null && offerPrice !== null ? { value: offerPrice, source: 'json-ld' as const } : null;

  const currency = pick<string>([
    ['json-ld', clean(offer?.priceCurrency ?? product?.priceCurrency)?.toUpperCase() ?? null],
    ['microdata', micro.get('pricecurrency')?.toUpperCase() ?? null],
    ['opengraph', clean(meta.get('product:price:currency') ?? meta.get('og:price:currency'))?.toUpperCase() ?? null],
  ]);

  const sku = pick<string>([
    ['json-ld', product ? clean(product.sku ?? product.mpn ?? product.gtin13 ?? product.productID) : null],
    ['microdata', micro.get('sku') ?? null],
    ['opengraph', clean(meta.get('product:retailer_item_id'))],
  ]);

  const category = pick<string>([
    ['json-ld', product ? nameOf(product.category) : null],
    ['microdata', micro.get('category') ?? null],
    ['opengraph', clean(meta.get('product:category') ?? meta.get('article:section'))],
  ]);

  const availabilityRaw = clean(offer?.availability ?? micro.get('availability') ?? meta.get('product:availability'));
  const availability = availabilityRaw
    ? { value: availabilityRaw.replace(/^https?:\/\/schema\.org\//i, ''), source: 'json-ld' as const }
    : null;

  // Images: the JSON-LD `image` may be a string, an array, or an ImageObject.
  const jsonImages = (() => {
    const raw = product?.image;
    const list = Array.isArray(raw) ? raw : [raw];
    return list
      .map((item) =>
        absoluteUrl(typeof item === 'object' && item !== null ? (item as Record<string, unknown>).url : item, pageUrl),
      )
      .filter((url): url is string => Boolean(url));
  })();

  const ogImages = [meta.get('og:image'), meta.get('og:image:secure_url'), meta.get('twitter:image')]
    .map((value) => absoluteUrl(value, pageUrl))
    .filter((url): url is string => Boolean(url));

  const microImage = absoluteUrl(micro.get('image'), pageUrl);

  const allImages = [...new Set([...jsonImages, ...ogImages, ...(microImage ? [microImage] : [])])];

  const mainImage = allImages[0]
    ? { value: allImages[0], source: (jsonImages[0] ? 'json-ld' : 'opengraph') as FieldSource }
    : null;

  const videoUrl = (() => {
    const candidate =
      absoluteUrl(
        typeof product?.video === 'object' && product.video !== null
          ? (product.video as Record<string, unknown>).contentUrl
          : product?.video,
        pageUrl,
      ) ?? absoluteUrl(meta.get('og:video') ?? meta.get('og:video:secure_url'), pageUrl);
    return candidate ? { value: candidate, source: 'json-ld' as FieldSource } : null;
  })();

  const features = (() => {
    const fromJsonLd = Array.isArray(product?.additionalProperty)
      ? product.additionalProperty
          .map((item) => {
            if (!item || typeof item !== 'object') return null;
            const record = item as Record<string, unknown>;
            const label = clean(record.name);
            const value = clean(record.value);
            return label && value ? `${label}: ${value}` : (label ?? value);
          })
          .filter((item): item is string => Boolean(item))
      : [];

    return fromJsonLd.length > 0 ? fromJsonLd.slice(0, 12) : listItems(html);
  })();

  const result: ExtractedProduct = {
    name,
    brand,
    description,
    price,
    salePrice,
    currency,
    sku,
    category,
    availability,
    mainImage,
    galleryImages: allImages.slice(1, 9),
    videoUrl,
    features,
    missing: [],
  };

  // Stated plainly rather than papered over: the import screen asks the operator
  // to supply these instead of an ad quietly going out without a price.
  result.missing = (
    [
      ['name', name],
      ['brand', brand],
      ['description', description],
      ['price', price],
      ['currency', currency],
      ['mainImage', mainImage],
    ] as const
  )
    .filter(([, field]) => field === null)
    .map(([key]) => key);

  return result;
}
