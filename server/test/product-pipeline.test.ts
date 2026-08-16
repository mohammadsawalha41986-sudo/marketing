/**
 * Product import and ad copy, through the HTTP routes.
 *
 * The copy tests are mostly negative, and deliberately so. It is easy to check
 * that a headline came out; what actually protects the client is checking that
 * the copy contains **no claim the product did not make** — no price when there
 * is no price, no discount when there is no discount, and none of the review,
 * rating, guarantee or delivery language that ad copy drifts toward.
 */

import { beforeAll, describe, expect, it, vi, afterEach } from 'vitest';
import sharp from 'sharp';
import { Platform } from '@prisma/client';

import { Agent, agent, createTenant, prisma, resetDatabase, type Tenant } from './helpers.js';
import { generateAllCopy, generateCopy } from '../src/services/product/copy.js';

vi.mock('node:dns/promises', async () => {
  const actual = await vi.importActual<typeof import('node:dns/promises')>('node:dns/promises');
  return {
    ...actual,
    lookup: vi.fn(async (hostname: string) => {
      if (hostname === 'internal.example.com') return [{ address: '10.0.0.5', family: 4 }];
      return [{ address: '93.184.216.34', family: 4 }];
    }),
  };
});

const PRODUCT_PAGE = `<!doctype html><html><head>
<title>Stone Oven Margherita — Forno Rosso</title>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Product",
 "name":"Stone Oven Margherita",
 "description":"Hand-stretched dough, San Marzano tomatoes and fior di latte, fired at 450C.",
 "sku":"PZ-MARG-12","brand":{"@type":"Brand","name":"Forno Rosso"},"category":"Pizza",
 "image":["https://cdn.example.com/margherita.jpg"],
 "offers":{"@type":"Offer","price":"42.50","priceCurrency":"SAR","availability":"https://schema.org/InStock"}}
</script></head><body></body></html>`;

async function productImage(): Promise<Buffer> {
  return sharp({ create: { width: 1200, height: 900, channels: 3, background: { r: 210, g: 80, b: 40 } } })
    .jpeg()
    .toBuffer();
}

/** Serve the page and the image, so the import runs end to end. */
async function stubNetwork() {
  const image = await productImage();

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      const href = String(url);
      const isImage = href.includes('margherita.jpg');
      const body = isImage ? image : Buffer.from(PRODUCT_PAGE);

      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': isImage ? 'image/jpeg' : 'text/html; charset=utf-8' }),
        body: null,
        arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      } as unknown as Response;
    }),
  );
}

describe('importing a product from a URL', () => {
  let alpha: Tenant;
  let beta: Tenant;
  let admin: Agent;
  let betaAdmin: Agent;

  beforeAll(async () => {
    await resetDatabase();
    alpha = await createTenant('alpha');
    beta = await createTenant('beta');
    admin = agent();
    await admin.login(alpha.adminEmail);
    betaAdmin = agent();
    await betaAdmin.login(beta.adminEmail);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('extracts the product and pulls its imagery into our own storage', async () => {
    await stubNetwork();

    const response = await admin.post('/api/products/import', {
      url: 'https://shop.example.com/products/margherita',
      clientId: alpha.clientId,
    });

    expect(response.status).toBe(201);
    expect(response.body.product.name).toBe('Stone Oven Margherita');
    expect(response.body.product.brand).toBe('Forno Rosso');
    expect(Number(response.body.product.price)).toBe(42.5);
    expect(response.body.product.currency).toBe('SAR');
    expect(response.body.missing).toEqual([]);
    expect(response.body.provenance.name).toBe('json-ld');

    // The image is a Media row of ours, not a link to the merchant's CDN — a
    // creative built on a hotlink breaks when they reorganise their bucket.
    expect(response.body.images.imported).toBe(1);
    const media = await prisma.media.findFirst({ where: { clientId: alpha.clientId, category: 'product' } });
    expect(media).not.toBeNull();
    expect(media!.filename.startsWith(`clients/${alpha.clientId}/assets/`)).toBe(true);
  });

  it('refuses a URL that resolves into private network space', async () => {
    await stubNetwork();

    const response = await admin.post('/api/products/import', {
      url: 'https://internal.example.com/admin',
      clientId: alpha.clientId,
    });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/private/i);
  });

  it('refuses a non-https scheme outright', async () => {
    const response = await admin.post('/api/products/import', {
      url: 'file:///etc/passwd',
      clientId: alpha.clientId,
    });
    // Rejected by URL validation before anything is fetched.
    expect(response.status).toBe(400);
  });

  it('will not import into another tenant’s client', async () => {
    await stubNetwork();

    const response = await betaAdmin.post('/api/products/import', {
      url: 'https://shop.example.com/products/margherita',
      clientId: alpha.clientId,
    });

    expect(response.status).toBe(404);
  });

  it('says so plainly when the page is not a product page', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/html' }),
        body: null,
        arrayBuffer: async () => new TextEncoder().encode('<html><head></head><body>Hello</body></html>').buffer,
      })) as unknown as typeof fetch,
    );

    const response = await admin.post('/api/products/import', {
      url: 'https://shop.example.com/about',
      clientId: alpha.clientId,
    });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/no product could be read/i);
  });

  it('keeps one tenant’s products out of another’s list', async () => {
    const mine = await admin.get('/api/products');
    const theirs = await betaAdmin.get('/api/products');

    expect(mine.body.products.length).toBeGreaterThan(0);
    expect(theirs.body.products).toHaveLength(0);
  });
});

describe('generating platform copy', () => {
  const full = {
    name: 'Stone Oven Margherita',
    brand: 'Forno Rosso',
    description: 'Hand-stretched dough, San Marzano tomatoes and fior di latte, fired at 450C.',
    price: 42.5,
    salePrice: null,
    currency: 'SAR',
    category: 'Pizza',
    features: ['Fired at 450C in a stone oven', 'San Marzano tomatoes'],
  };

  it('shapes fields to what each ad manager actually asks for', () => {
    const google = generateCopy(full, Platform.GOOGLE_ADS);
    const facebook = generateCopy(full, Platform.FACEBOOK);
    const tiktok = generateCopy(full, Platform.TIKTOK);

    expect(google.fields.map((f) => f.label)).toEqual(
      expect.arrayContaining(['Headline 1', 'Headline 2', 'Headline 3', 'Long headline', 'Description']),
    );
    expect(facebook.fields.map((f) => f.label)).toEqual(
      expect.arrayContaining(['Primary text', 'Headline', 'Description']),
    );
    expect(tiktok.fields.map((f) => f.label)).toContain('Hook');
  });

  it('respects every platform character limit', () => {
    // A 34-character Google headline is rejected at upload, after the operator
    // thinks the work is done.
    for (const copy of generateAllCopy(full)) {
      for (const field of copy.fields) {
        expect(field.value.length, `${copy.platform} ${field.label}`).toBeLessThanOrEqual(field.maxLength);
      }
    }
  });

  it('attributes every string to the product fields it came from', () => {
    for (const copy of generateAllCopy(full)) {
      for (const field of copy.fields) {
        expect(field.from.length, `${copy.platform} ${field.label}`).toBeGreaterThan(0);
      }
    }
  });

  it('states the price only when the product has one', () => {
    const withPrice = generateCopy(full, Platform.INSTAGRAM);
    expect(JSON.stringify(withPrice.fields)).toMatch(/42\.5|SAR/);

    const priceless = generateCopy({ ...full, price: null, currency: null }, Platform.INSTAGRAM);
    // No number, no currency, and the absence is reported rather than hidden.
    expect(JSON.stringify(priceless.fields)).not.toMatch(/42\.5|SAR|\$/);
    expect(priceless.omitted.join(' ')).toMatch(/no price stated/i);
  });

  it('claims a discount only when there is a real one', () => {
    const discounted = generateCopy({ ...full, price: 60, salePrice: 42.5 }, Platform.FACEBOOK);
    expect(JSON.stringify(discounted.fields)).toMatch(/save 29%/);

    // Equal figures are not an offer, and "was 42.50, now 42.50" is a lie.
    const flat = generateCopy({ ...full, price: 42.5, salePrice: 42.5 }, Platform.FACEBOOK);
    expect(JSON.stringify(flat.fields)).not.toMatch(/save|was/i);
  });

  it('never fabricates reviews, ratings, guarantees or delivery promises', () => {
    const banned =
      /\b(\d+(\.\d+)?\s*stars?|rated|reviews?|best[- ]selling|guaranteed?|warrant(y|ied)|free delivery|next[- ]day|certified|clinically|doctor[- ]recommended|money[- ]back)\b/i;

    for (const product of [full, { ...full, price: null, description: null, features: [] }]) {
      for (const copy of generateAllCopy(product)) {
        for (const field of copy.fields) {
          expect(field.value, `${copy.platform} ${field.label}`).not.toMatch(banned);
        }
        for (const tag of copy.hashtags) expect(tag).not.toMatch(banned);
      }
    }
  });

  it('builds hashtags from the product’s own words, not a trending list', () => {
    const copy = generateCopy(full, Platform.INSTAGRAM);
    expect(copy.hashtags.length).toBeGreaterThan(0);
    for (const tag of copy.hashtags) {
      const word = tag.slice(1).toLowerCase();
      const source = `${full.name} ${full.brand} ${full.category} ${full.features.join(' ')}`
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
      // Every tag is derived from words the product actually contains.
      expect(source.includes(word.slice(0, 6))).toBe(true);
    }
  });

  it('degrades honestly when the product is nearly empty', () => {
    const bare = { name: 'Mystery Item', brand: null, description: null, price: null, salePrice: null, currency: null, category: null, features: [] };
    const copy = generateCopy(bare, Platform.INSTAGRAM);

    expect(copy.fields.every((field) => field.value.length > 0)).toBe(true);
    expect(copy.omitted.length).toBeGreaterThanOrEqual(2);
    // It names the product and stops. It does not describe one it cannot see.
    expect(copy.fields.find((f) => f.label === 'Caption')?.value).toBe('Mystery Item');
  });
});

describe('copy over HTTP', () => {
  let alpha: Tenant;
  let admin: Agent;
  let productId: string;

  beforeAll(async () => {
    await resetDatabase();
    alpha = await createTenant('alpha');
    admin = agent();
    await admin.login(alpha.adminEmail);

    await stubNetwork();
    const imported = await admin.post('/api/products/import', {
      url: 'https://shop.example.com/products/margherita',
      clientId: alpha.clientId,
      importImages: false,
    });
    productId = imported.body.product.id;
    vi.unstubAllGlobals();
  });

  it('returns copy for every platform, and for one on request', async () => {
    const all = await admin.get(`/api/products/${productId}/copy`);
    expect(all.status).toBe(200);
    expect(all.body.copy.length).toBeGreaterThanOrEqual(6);

    const one = await admin.get(`/api/products/${productId}/copy?platform=GOOGLE_ADS`);
    expect(one.body.copy).toHaveLength(1);
    expect(one.body.copy[0].platform).toBe('GOOGLE_ADS');
  });
});
