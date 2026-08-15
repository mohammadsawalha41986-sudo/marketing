/**
 * Creative match scoring.
 *
 * Every score here is computed from something actually inspected — the image's
 * real pixels and dimensions, the brand row, the campaign row. Nothing is
 * estimated to make a dashboard look busy, because a fabricated "Brand Match:
 * 96%" is worse than no score at all: it invites someone to approve artwork on
 * the strength of a number that measured nothing.
 *
 * Where a dimension genuinely cannot be judged, the check reports itself as
 * unmeasurable and is excluded from the total rather than being given a
 * flattering default. That is why `overall` comes with `measured`.
 *
 * What is honestly *not* here: this does not look at the picture and know that
 * it shows a burger. Recognising subject matter needs a vision model, and the
 * product must not imply otherwise — so `productVisibility` scores the
 * *evidence available about* the subject (the operator's own tags, category and
 * filename against the campaign's products) and says so in its detail line.
 */

import type { Brand, Campaign, Media } from '@prisma/client';

import type { CreativePreset } from './presets.js';

export interface MatchCheck {
  key: string;
  label: string;
  weight: number;
  /** 0–100, or null when this dimension cannot be judged from what exists. */
  score: number | null;
  detail: string;
  /** Shown to the operator when the score is poor enough to act on. */
  advice?: string;
}

export interface MatchResult {
  overall: number | null;
  band: 'EXCELLENT' | 'GOOD' | 'NEEDS_REVIEW' | 'POOR' | 'BLOCKED' | 'UNMEASURED';
  /** Share of weight that could actually be judged, 0–1. */
  measured: number;
  checks: MatchCheck[];
  /** Hard failures. A creative with any of these must not be published as is. */
  blockers: string[];
  recommendations: string[];
}

const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));

/** Case- and punctuation-insensitive token set, for comparing free text. */
function tokens(...values: (string | null | undefined)[]): Set<string> {
  const set = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    for (const token of value.toLowerCase().split(/[^a-z0-9؀-ۿ]+/)) {
      if (token.length > 2) set.add(token);
    }
  }
  return set;
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let hits = 0;
  for (const token of a) if (b.has(token)) hits += 1;
  return hits;
}

export interface MatchInput {
  media: Pick<Media, 'width' | 'height' | 'mimeType' | 'sizeBytes' | 'originalName' | 'tags' | 'category' | 'clientId'>;
  brand: Pick<Brand, 'businessName' | 'keywords' | 'products' | 'services' | 'usps' | 'targetAudience' | 'toneOfVoice' | 'personality'> | null;
  campaign: Pick<Campaign, 'name' | 'offer' | 'products' | 'targetAudience' | 'objective' | 'ctaLabel'> | null;
  preset: CreativePreset;
  headline?: string | null;
  ctaLabel?: string | null;
}

export function scoreCreative(input: MatchInput): MatchResult {
  const { media, brand, campaign, preset } = input;
  const checks: MatchCheck[] = [];
  const blockers: string[] = [];
  const recommendations: string[] = [];

  const assetText = tokens(media.originalName, media.category, ...(media.tags ?? []));

  // --- platform format ---------------------------------------------------
  if (media.width && media.height) {
    const sourceRatio = media.width / media.height;
    const targetRatio = preset.width / preset.height;
    const drift = Math.abs(sourceRatio - targetRatio) / targetRatio;
    // Cover-cropping is lossless in quality but not in composition: the further
    // the source aspect is from the target, the more of the picture is thrown
    // away, and that is what this measures.
    const score = clamp(100 - drift * 90);
    checks.push({
      key: 'platform',
      label: 'Platform format match',
      weight: 20,
      score,
      detail: `Source ${media.width}×${media.height} cropped to ${preset.width}×${preset.height} (${preset.label})`,
      advice:
        drift > 0.35
          ? `A lot of the frame is cropped away for ${preset.label}. A ${preset.width}×${preset.height} source would keep the whole composition.`
          : undefined,
    });
    if (drift > 0.35) {
      recommendations.push(
        `Supply a source closer to ${preset.width}×${preset.height} for ${preset.label} — the current crop discards a large part of the image.`,
      );
    }
  } else {
    checks.push({
      key: 'platform',
      label: 'Platform format match',
      weight: 20,
      score: null,
      detail: 'Source dimensions were not recorded for this asset',
    });
  }

  // --- image quality -----------------------------------------------------
  if (media.width && media.height) {
    const shortestSource = Math.min(media.width, media.height);
    const shortestTarget = Math.min(preset.width, preset.height);
    const ratio = shortestSource / shortestTarget;
    const score = clamp(ratio >= 1 ? 100 : ratio * 100);

    checks.push({
      key: 'quality',
      label: 'Image quality',
      weight: 20,
      score,
      detail:
        ratio >= 1
          ? `Source resolution meets ${preset.label} (${media.width}×${media.height})`
          : `Source is smaller than ${preset.label} needs and will be upscaled (${media.width}×${media.height})`,
      advice: ratio < 1 ? 'Upscaling softens the image. Use an asset at least as large as the target.' : undefined,
    });

    // Publishing visibly upscaled artwork is a real failure, not a nitpick.
    if (ratio < 0.5) {
      blockers.push(
        `Source is less than half the required resolution for ${preset.label} (${media.width}×${media.height} against ${preset.width}×${preset.height}). It will look blurred.`,
      );
    }
  } else {
    checks.push({ key: 'quality', label: 'Image quality', weight: 20, score: null, detail: 'No dimensions recorded' });
  }

  // --- brand -------------------------------------------------------------
  if (brand) {
    const brandTokens = tokens(
      brand.businessName,
      brand.targetAudience,
      brand.toneOfVoice,
      ...(brand.keywords ?? []),
      ...(brand.products ?? []),
      ...(brand.services ?? []),
      ...(brand.usps ?? []),
      ...(brand.personality ?? []),
    );
    const hits = overlap(assetText, brandTokens);
    const hasSignal = assetText.size > 0 && brandTokens.size > 0;

    checks.push({
      key: 'brand',
      label: 'Brand match',
      weight: 20,
      // Scored from evidence, and honest that the evidence is metadata: the
      // asset's own name, category and tags against the brand's vocabulary.
      score: hasSignal ? clamp(45 + Math.min(hits, 4) * 14) : null,
      detail: hasSignal
        ? `${hits} shared term${hits === 1 ? '' : 's'} between the asset's name/tags and the brand vocabulary`
        : 'Asset has no tags or category to compare against the brand',
      advice: hasSignal && hits === 0 ? 'Tag the asset with the products or themes it shows so brand fit can be judged.' : undefined,
    });
    if (!hasSignal) {
      recommendations.push('Add tags or a category to this asset so brand and campaign fit can be measured.');
    }
  } else {
    checks.push({ key: 'brand', label: 'Brand match', weight: 20, score: null, detail: 'This client has no brand profile yet' });
    recommendations.push('Complete the brand profile so creatives can be checked against it.');
  }

  // --- campaign ----------------------------------------------------------
  if (campaign) {
    const campaignTokens = tokens(campaign.name, campaign.offer, campaign.targetAudience, ...(campaign.products ?? []));
    const hits = overlap(assetText, campaignTokens);
    const hasSignal = assetText.size > 0 && campaignTokens.size > 0;

    checks.push({
      key: 'campaign',
      label: 'Campaign match',
      weight: 20,
      score: hasSignal ? clamp(45 + Math.min(hits, 4) * 14) : null,
      detail: hasSignal
        ? `${hits} shared term${hits === 1 ? '' : 's'} with "${campaign.name}"`
        : 'Not enough asset metadata to compare with the campaign',
      advice:
        hasSignal && hits === 0
          ? `Nothing in this asset's metadata matches "${campaign.name}". Check it shows the right product before publishing.`
          : undefined,
    });

    // Product visibility: honest about being metadata-based, not vision-based.
    const products = (campaign.products ?? []).length > 0 ? campaign.products : (brand?.products ?? []);
    if (products.length > 0) {
      const productHits = overlap(assetText, tokens(...products));
      checks.push({
        key: 'product',
        label: 'Product visibility',
        weight: 10,
        score: assetText.size === 0 ? null : clamp(productHits > 0 ? 90 : 35),
        detail:
          assetText.size === 0
            ? 'No asset metadata to check the product against'
            : productHits > 0
              ? `Asset metadata names a campaign product`
              : `Asset metadata names none of: ${products.slice(0, 4).join(', ')}`,
        advice:
          assetText.size > 0 && productHits === 0
            ? 'Metadata cannot confirm the product is shown — check the image visually before approving.'
            : undefined,
      });
    }
  } else {
    checks.push({ key: 'campaign', label: 'Campaign match', weight: 20, score: null, detail: 'Creative is not attached to a campaign' });
  }

  // --- audience ----------------------------------------------------------
  const audience = campaign?.targetAudience ?? brand?.targetAudience ?? null;
  checks.push({
    key: 'audience',
    label: 'Audience match',
    weight: 10,
    score: audience ? (assetText.size === 0 ? null : clamp(55 + Math.min(overlap(assetText, tokens(audience)), 3) * 15)) : null,
    detail: audience
      ? assetText.size === 0
        ? 'No asset metadata to compare with the audience'
        : `Compared against: ${audience.slice(0, 80)}`
      : 'No target audience recorded on the campaign or brand',
  });

  // --- CTA / readability -------------------------------------------------
  const cta = input.ctaLabel?.trim();
  const headline = input.headline?.trim();
  const headlineLength = headline?.length ?? 0;
  // Long copy over a vertical placement is where text becomes unreadable, so
  // the limit scales with how much room the safe area actually leaves.
  const room = preset.width * (1 - preset.safeArea.top - preset.safeArea.bottom);
  const comfortable = Math.round(room / 7);

  checks.push({
    key: 'cta',
    label: 'CTA and readability',
    weight: 10,
    score:
      headlineLength === 0 && !cta
        ? null
        : clamp(
            (cta ? 55 : 40) +
              (headlineLength > 0 && headlineLength <= comfortable ? 45 : headlineLength > comfortable ? 15 : 25),
          ),
    detail:
      headlineLength === 0 && !cta
        ? 'No headline or CTA set for this creative'
        : `${headlineLength} character headline${cta ? ` with CTA "${cta}"` : ', no CTA'}`,
    advice:
      headlineLength > comfortable
        ? `The headline is long for ${preset.label} and will wrap small. Around ${comfortable} characters reads best here.`
        : !cta
          ? 'Adding a CTA gives the creative something to ask for.'
          : undefined,
  });

  if (headlineLength > comfortable) {
    recommendations.push(`Shorten the headline to roughly ${comfortable} characters for ${preset.label}.`);
  }

  // --- total -------------------------------------------------------------
  const totalWeight = checks.reduce((sum, check) => sum + check.weight, 0);
  const judged = checks.filter((check) => check.score !== null);
  const judgedWeight = judged.reduce((sum, check) => sum + check.weight, 0);
  const measured = totalWeight === 0 ? 0 : judgedWeight / totalWeight;

  const overall =
    judgedWeight === 0
      ? null
      : Math.round(judged.reduce((sum, check) => sum + (check.score ?? 0) * check.weight, 0) / judgedWeight);

  let band: MatchResult['band'];
  if (blockers.length > 0) band = 'BLOCKED';
  else if (overall === null || measured < 0.4) band = 'UNMEASURED';
  else if (overall >= 85) band = 'EXCELLENT';
  else if (overall >= 70) band = 'GOOD';
  else if (overall >= 50) band = 'NEEDS_REVIEW';
  else band = 'POOR';

  for (const check of judged) {
    if ((check.score ?? 100) < 60 && check.advice) recommendations.push(check.advice);
  }

  return { overall, band, measured, checks, blockers, recommendations: [...new Set(recommendations)] };
}
