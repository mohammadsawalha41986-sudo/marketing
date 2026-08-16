/**
 * Product extraction.
 *
 * The assertion that matters most in this file is a negative one: a page that
 * does not state a price must produce a product with **no price**, reported as
 * missing. Everything downstream — headline, caption, the offer scene in a video
 * — is generated from these fields, so a value invented here becomes a claim in
 * a paid advertisement. "Probably $19.99" is not a smaller bug than a crash.
 */

import { describe, expect, it } from 'vitest';

import { extractProduct } from '../src/services/product/extract.js';

const BASE = 'https://shop.example.com/products/stone-oven-pizza';

function page(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">${body}</head><body></body></html>`;
}

describe('structured data', () => {
  const jsonLd = page(`
    <title>Stone Oven Pizza — Example Shop</title>
    <script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@type": "Product",
      "name": "Stone Oven Margherita",
      "description": "Hand-stretched dough, San Marzano tomatoes, fior di latte.",
      "sku": "PZ-MARG-12",
      "brand": { "@type": "Brand", "name": "Forno Rosso" },
      "category": "Pizza",
      "image": [
        "https://cdn.example.com/margherita-1.jpg",
        "https://cdn.example.com/margherita-2.jpg"
      ],
      "offers": {
        "@type": "Offer",
        "price": "42.50",
        "priceCurrency": "SAR",
        "availability": "https://schema.org/InStock"
      }
    }
    </script>`);

  it('prefers the merchant’s own structured claim over page furniture', () => {
    const product = extractProduct(jsonLd, BASE);

    expect(product.name?.value).toBe('Stone Oven Margherita');
    expect(product.name?.source).toBe('json-ld');
    // Not "Stone Oven Pizza — Example Shop", which is the <title>.
    expect(product.brand?.value).toBe('Forno Rosso');
    expect(product.sku?.value).toBe('PZ-MARG-12');
    expect(product.category?.value).toBe('Pizza');
    expect(product.price?.value).toBe(42.5);
    expect(product.currency?.value).toBe('SAR');
    expect(product.availability?.value).toBe('InStock');
    expect(product.missing).toEqual([]);
  });

  it('collects the image gallery and picks a main image', () => {
    const product = extractProduct(jsonLd, BASE);

    expect(product.mainImage?.value).toBe('https://cdn.example.com/margherita-1.jpg');
    expect(product.galleryImages).toContain('https://cdn.example.com/margherita-2.jpg');
  });

  it('finds a Product nested inside an @graph', () => {
    // Shopify, WooCommerce and Squarespace all emit this shape.
    const graph = page(`<script type="application/ld+json">
      {"@context":"https://schema.org","@graph":[
        {"@type":"WebSite","name":"Example Shop"},
        {"@type":"BreadcrumbList","itemListElement":[]},
        {"@type":"Product","name":"Buried Product","offers":{"@type":"Offer","price":9.99,"priceCurrency":"USD"}}
      ]}</script>`);

    const product = extractProduct(graph, BASE);
    expect(product.name?.value).toBe('Buried Product');
    expect(product.price?.value).toBe(9.99);
  });

  it('survives one malformed JSON-LD block among good ones', () => {
    const mixed = page(`
      <script type="application/ld+json">{ this is not json }</script>
      <script type="application/ld+json">{"@type":"Product","name":"Still Found"}</script>`);

    expect(extractProduct(mixed, BASE).name?.value).toBe('Still Found');
  });
});

describe('falling back through the source hierarchy', () => {
  it('uses OpenGraph when there is no structured data', () => {
    const og = page(`
      <title>Ignore me</title>
      <meta property="og:title" content="Cast Iron Skillet">
      <meta property="og:description" content="Pre-seasoned, 12 inch.">
      <meta property="og:image" content="/img/skillet.jpg">
      <meta property="og:site_name" content="Ironworks">
      <meta property="product:price:amount" content="129.00">
      <meta property="product:price:currency" content="USD">`);

    const product = extractProduct(og, BASE);

    expect(product.name?.value).toBe('Cast Iron Skillet');
    expect(product.name?.source).toBe('opengraph');
    expect(product.price?.value).toBe(129);
    expect(product.currency?.value).toBe('USD');
    // Relative image resolved against the page it came from.
    expect(product.mainImage?.value).toBe('https://shop.example.com/img/skillet.jpg');
  });

  it('reads microdata when that is all the page has', () => {
    const micro = page('') .replace('<body></body>', `<body>
      <div itemscope itemtype="https://schema.org/Product">
        <h1 itemprop="name">Wool Throw Blanket</h1>
        <span itemprop="description">Lambswool, 130x180cm, woven in Yorkshire.</span>
        <meta itemprop="price" content="89.95">
        <meta itemprop="priceCurrency" content="GBP">
        <span itemprop="sku">WT-130180</span>
      </div></body>`);

    const product = extractProduct(micro, BASE);
    expect(product.name?.value).toBe('Wool Throw Blanket');
    expect(product.name?.source).toBe('microdata');
    expect(product.price?.value).toBe(89.95);
    expect(product.currency?.value).toBe('GBP');
    expect(product.sku?.value).toBe('WT-130180');
  });

  it('falls back to the page title only as a last resort', () => {
    const bare = page('<title>Something For Sale</title>');
    const product = extractProduct(bare, BASE);

    expect(product.name?.value).toBe('Something For Sale');
    expect(product.name?.source).toBe('html');
  });
});

describe('never inventing what the page did not say', () => {
  it('reports absent fields as missing rather than filling them in', () => {
    const sparse = page('<title>Mystery Item</title>');
    const product = extractProduct(sparse, BASE);

    expect(product.price).toBeNull();
    expect(product.currency).toBeNull();
    expect(product.brand).toBeNull();
    expect(product.mainImage).toBeNull();
    expect(product.missing).toEqual(
      expect.arrayContaining(['brand', 'description', 'price', 'currency', 'mainImage']),
    );
  });

  it('does not infer a product name from the URL slug', () => {
    // The URL says "stone-oven-pizza". A tempting guess, and still a guess.
    const empty = '<html><head></head><body><p>Nothing here</p></body></html>';
    const product = extractProduct(empty, BASE);

    expect(product.name).toBeNull();
    expect(product.missing).toContain('name');
  });

  it('refuses an unparseable price instead of rounding one into existence', () => {
    const weird = page(`<script type="application/ld+json">
      {"@type":"Product","name":"Call For Pricing","offers":{"@type":"Offer","price":"POA"}}</script>`);

    const product = extractProduct(weird, BASE);
    expect(product.name?.value).toBe('Call For Pricing');
    expect(product.price).toBeNull();
    expect(product.missing).toContain('price');
  });
});

describe('price parsing', () => {
  const priced = (value: string) =>
    extractProduct(
      page(`<script type="application/ld+json">
        {"@type":"Product","name":"X","offers":{"@type":"Offer","price":${JSON.stringify(value)}}}</script>`),
      BASE,
    ).price?.value ?? null;

  it('reads both European and Anglo decimal conventions correctly', () => {
    // Reading "1.234,56" as 1.234 understates a price by three orders of
    // magnitude — in an advert, that is a price nobody agreed to honour.
    expect(priced('1.234,56')).toBe(1234.56);
    expect(priced('1,234.56')).toBe(1234.56);
    expect(priced('1234.56')).toBe(1234.56);
    expect(priced('1 234,56')).toBe(1234.56);
  });

  it('strips currency symbols without losing the amount', () => {
    expect(priced('$49.99')).toBe(49.99);
    expect(priced('49.99 USD')).toBe(49.99);
    expect(priced('SAR 187.50')).toBe(187.5);
  });
});

describe('sale pricing', () => {
  it('reports a discount only when the page states two different prices', () => {
    const discounted = page(`<script type="application/ld+json">
      {"@type":"Product","name":"Winter Coat","offers":{
        "@type":"AggregateOffer","lowPrice":"180.00","highPrice":"300.00","priceCurrency":"USD"}}</script>`);

    const product = extractProduct(discounted, BASE);
    expect(product.price?.value).toBe(300);
    expect(product.salePrice?.value).toBe(180);
  });

  it('does not manufacture a discount when both figures are the same', () => {
    const flat = page(`<script type="application/ld+json">
      {"@type":"Product","name":"Winter Coat","offers":{
        "@type":"AggregateOffer","lowPrice":"180.00","highPrice":"180.00","priceCurrency":"USD"}}</script>`);

    const product = extractProduct(flat, BASE);
    expect(product.price?.value).toBe(180);
    // "Was 180, now 180" is a fabricated offer.
    expect(product.salePrice).toBeNull();
  });
});

describe('features', () => {
  it('prefers declared properties over scraped list items', () => {
    const withProps = page(`<script type="application/ld+json">
      {"@type":"Product","name":"Espresso Machine","additionalProperty":[
        {"@type":"PropertyValue","name":"Pressure","value":"9 bar"},
        {"@type":"PropertyValue","name":"Water tank","value":"1.8 L"}]}</script>`);

    expect(extractProduct(withProps, BASE).features).toEqual(['Pressure: 9 bar', 'Water tank: 1.8 L']);
  });

  it('filters navigation chrome out of scraped bullets', () => {
    const html = `<html><head><title>Kettle</title></head><body>
      <ul><li>Home</li><li>Cart</li><li>My account</li></ul>
      <ul><li>Rapid boil element reaches 100C in 45 seconds</li>
          <li>Removable limescale filter, washable</li></ul>
    </body></html>`;

    const features = extractProduct(html, BASE).features;
    expect(features).not.toContain('Home');
    expect(features).not.toContain('Cart');
    expect(features.some((item) => item.includes('Rapid boil'))).toBe(true);
  });
});

describe('text handling', () => {
  it('decodes entities so copy does not carry raw markup', () => {
    const entities = page(`<script type="application/ld+json">
      {"@type":"Product","name":"Ben &amp; Jerry&#39;s Tub","description":"Sweet &amp; salty"}</script>`);

    const product = extractProduct(entities, BASE);
    expect(product.name?.value).toBe("Ben & Jerry's Tub");
    expect(product.description?.value).toBe('Sweet & salty');
  });

  it('ignores an image URL with a scheme that cannot be fetched', () => {
    const dataUri = page(`<meta property="og:image" content="data:image/png;base64,AAAA">
      <title>Thing</title>`);

    expect(extractProduct(dataUri, BASE).mainImage).toBeNull();
  });
});
