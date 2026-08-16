/**
 * The video script: HOOK → PRODUCT → BENEFIT → OFFER → CTA.
 *
 * A scene is only included when the product carries the information it needs.
 * The OFFER scene requires a real price; with no price there is no offer scene,
 * because a five-second card reading "Special offer" over a product that has no
 * stated price is an advertisement making a claim nobody wrote.
 *
 * Every line is editable afterwards — this produces a starting script, not a
 * final one — but the default must be defensible on its own, because in practice
 * defaults are what ship.
 */

import type { ProductForCopy } from '../product/copy.js';

export type SceneKind = 'HOOK' | 'PRODUCT' | 'BENEFIT' | 'OFFER' | 'CTA';

/** How the frame moves during a scene. Advertising motion, not a slideshow. */
export type Motion = 'ZOOM_IN' | 'ZOOM_OUT' | 'PAN_LEFT' | 'PAN_RIGHT' | 'STATIC';

export interface Scene {
  kind: SceneKind;
  /** The line burned into this scene. Editable. */
  text: string;
  /** Secondary line, when the scene has one. */
  subtext?: string | null;
  durationSeconds: number;
  motion: Motion;
  /** Which product fields this scene's text came from. */
  from: string[];
}

export interface VideoScript {
  scenes: Scene[];
  totalSeconds: number;
  /** Scenes deliberately not generated, and why. */
  omitted: string[];
}

function money(amount: number, currency: string | null | undefined): string {
  if (!currency) return String(amount);
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

/**
 * Build the default script for a product.
 *
 * `targetSeconds` shapes the pacing rather than the content: the scenes that
 * exist are decided by what the product states, then the available time is
 * distributed across them. A hook gets less time than a benefit because it is
 * three words and the benefit is a sentence somebody has to read.
 */
export function buildScript(product: ProductForCopy, targetSeconds = 15): VideoScript {
  const omitted: string[] = [];
  const scenes: Array<Omit<Scene, 'durationSeconds'> & { weight: number }> = [];

  // HOOK — a question, never a claim. "The best pizza in Riyadh" is a
  // superlative the product data cannot support.
  scenes.push({
    kind: 'HOOK',
    text: product.category ? `Looking for ${product.category.toLowerCase()}?` : `Meet ${product.name}`,
    subtext: null,
    motion: 'ZOOM_IN',
    from: product.category ? ['category'] : ['name'],
    weight: 0.8,
  });

  scenes.push({
    kind: 'PRODUCT',
    text: product.name,
    subtext: product.brand ?? null,
    motion: 'STATIC',
    from: ['name', ...(product.brand ? ['brand'] : [])],
    weight: 1,
  });

  const benefit = product.features.find((item) => item.length >= 12) ?? product.description ?? null;
  if (benefit) {
    scenes.push({
      kind: 'BENEFIT',
      text: benefit,
      subtext: null,
      motion: 'PAN_LEFT',
      from: product.features.length > 0 ? ['features'] : ['description'],
      weight: 1.4,
    });
  } else {
    omitted.push('No benefit scene: the product has no description or features to state.');
  }

  if (typeof product.price === 'number') {
    const discounted = typeof product.salePrice === 'number' && product.salePrice < product.price;
    scenes.push({
      kind: 'OFFER',
      text: discounted ? money(product.salePrice!, product.currency) : money(product.price, product.currency),
      subtext: discounted ? `was ${money(product.price, product.currency)}` : null,
      motion: 'ZOOM_OUT',
      from: ['price', ...(discounted ? ['salePrice'] : []), ...(product.currency ? ['currency'] : [])],
      weight: 0.9,
    });
  } else {
    omitted.push('No offer scene: the product page did not state a price, so none is shown.');
  }

  scenes.push({
    kind: 'CTA',
    text: product.category?.toLowerCase().includes('service') ? 'Learn more' : 'Shop now',
    subtext: product.brand ?? null,
    motion: 'ZOOM_IN',
    from: ['category'],
    weight: 0.9,
  });

  /*
   * Distribute the target length by weight, then clamp. Below ~1.4s a viewer
   * cannot read a line; above ~6s a single card in a 15-second ad is dead air.
   */
  const totalWeight = scenes.reduce((sum, scene) => sum + scene.weight, 0);
  const withDuration: Scene[] = scenes.map(({ weight, ...scene }) => ({
    ...scene,
    durationSeconds: Number(Math.min(6, Math.max(1.4, (targetSeconds * weight) / totalWeight)).toFixed(2)),
  }));

  return {
    scenes: withDuration,
    totalSeconds: Number(withDuration.reduce((sum, scene) => sum + scene.durationSeconds, 0).toFixed(2)),
    omitted,
  };
}
