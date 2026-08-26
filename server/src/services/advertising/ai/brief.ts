/**
 * The creative brief, and platform-specific copy.
 *
 * This is the only part of the AI Advertising Engine that calls a language
 * model, and the split is deliberate. Deciding *which campaign is winning* is a
 * comparison between measured numbers, and a model asked to do it will
 * sometimes do it from numbers that were not there. Writing a hook is the
 * opposite: there is no fact of the matter, and a model is genuinely better at
 * it than a template. So analysis stays deterministic in `insights.ts`, and
 * generation happens here.
 *
 * Three constraints shape it.
 *
 * **Reuse the existing facade.** `services/ai` already owns the OpenAI client,
 * the template fallback, brand context, forbidden-word scrubbing and the
 * `AiResult` envelope that reports which provider actually answered. Nothing
 * here constructs a client, and nothing here invents a second fallback story.
 *
 * **Never claim a format the platform does not have.** The brief names an
 * aspect ratio, a duration and a placement, and every one of those is read from
 * the capability and media registries rather than from the model. A model asked
 * for "the right aspect ratio for TikTok" will answer plausibly whether or not
 * TikTok is even connected here.
 *
 * **Say who wrote it.** Where `OPENAI_API_KEY` is absent the existing template
 * engine answers, and the result is labelled RULE_BASED rather than presented
 * as though a model had been consulted. §28 is explicit, and it is the kind of
 * thing that is easy to let slide because the output looks the same.
 */

import { Platform } from '@prisma/client';

import { generateCopy, generateHashtags, aiStatus } from '../../ai/index.js';
import type { BrandContext, ContentRequest } from '../../ai/context.js';
import { capabilityFor } from '../../social/capabilities.js';
import { ruleFor } from '../../social/media-rules.js';
import { matrixFor } from '../../marketing/capability-matrix.js';

/** Who actually produced the words. Never blurred. */
export type BriefOrigin = 'AI_GENERATED' | 'RULE_BASED';

export interface BriefPlacement {
  key: string;
  label: string;
  surface: string;
  /** From media-rules, when that surface declares one. */
  aspectRatio: string | null;
  maxDurationSeconds: number | null;
}

export interface CreativeBrief {
  platform: Platform;
  objective: string;
  /** What the platform can actually run, from the registries. */
  placements: BriefPlacement[];
  formats: string[];
  origin: BriefOrigin;
  /** The provider that answered, and whether it was the fallback. */
  provider: { name: string; model: string; isFallback: boolean; notice?: string };
  angle: string;
  hook: string;
  headline: string;
  primaryText: string;
  callToAction: string;
  visualConcept: string;
  offerFraming: string | null;
  hashtags: string[];
  /** Labelled honestly: relevance, not measured performance. See §19. */
  hashtagBasis: 'RELEVANCE';
  testingVariations: string[];
  /** Anything the brief could not honestly fill in. */
  limitations: string[];
}

export class BriefUnavailableError extends Error {
  readonly platform: Platform;
  readonly detail: string;

  constructor(platform: Platform, detail: string) {
    super(detail);
    this.name = 'BriefUnavailableError';
    this.platform = platform;
    this.detail = detail;
  }
}

/**
 * The placements this platform can actually run, with their real constraints.
 *
 * Read from `social/capabilities.ts` and `social/media-rules.ts` — the same two
 * registries the composer and the ad preview use — so a brief cannot promise a
 * format the publisher would refuse.
 */
function placementsFor(platform: Platform): BriefPlacement[] {
  return capabilityFor(platform).adPlacements.map((placement) => {
    const rule = ruleFor(platform, placement.surface);
    return {
      key: placement.key,
      label: placement.label,
      surface: placement.surface,
      aspectRatio: rule?.ratio?.recommended ?? null,
      maxDurationSeconds: rule?.maxDurationSeconds ?? null,
    };
  });
}

export interface BriefInput {
  brand: BrandContext;
  platform: Platform;
  objective: string;
  language: 'EN' | 'AR';
  audience?: string | null;
  location?: string | null;
  offer?: string | null;
  creativeType?: string | null;
}

/**
 * Build a brief for one platform.
 *
 * One generation call, not one per field: §36 is explicit about not sending
 * repeated token-heavy prompts, and the existing `generateCopy` already returns
 * every field a brief needs in a single structured response.
 */
export async function creativeBrief(input: BriefInput): Promise<CreativeBrief> {
  /*
   * Refuse before generating. A brief for a platform this deployment cannot
   * advertise on is a document describing an advertisement nobody can run, and
   * producing one is worse than declining — the operator would act on it.
   */
  const paid = matrixFor(input.platform).paid;
  if (paid.state === 'NOT_IMPLEMENTED' || paid.state === 'NOT_SUPPORTED') {
    throw new BriefUnavailableError(
      input.platform,
      paid.capabilities.find((capability) => capability.surface === 'CAMPAIGNS')?.detail
        ?? 'This platform has no advertising integration in this deployment.',
    );
  }

  const placements = placementsFor(input.platform);
  const capability = capabilityFor(input.platform);

  const request: ContentRequest = {
    platform: input.platform,
    // The platform's own leading format, so the copy is shaped for it rather
    // than written once and pasted everywhere. §18.
    contentType: input.creativeType ?? capability.formats[0] ?? 'IMAGE',
    language: input.language,
    productService: input.brand.products?.[0] ?? null,
    offer: input.offer ?? null,
    audience: input.audience ?? null,
    adName: input.objective,
  };

  const copy = await generateCopy(input.brand, request);
  const tags = await generateHashtags(input.brand, request);

  const limitations: string[] = [];
  if (placements.length === 0) {
    limitations.push('No advertising placements are declared for this platform, so no placement is named.');
  }
  if (placements.every((placement) => placement.aspectRatio === null)) {
    limitations.push('No aspect ratio is declared for these placements, so none is stated.');
  }
  if (copy.isFallback) {
    limitations.push(copy.notice ?? 'No language model is configured; the built-in template engine produced this brief.');
  }

  return {
    platform: input.platform,
    objective: input.objective,
    placements,
    formats: capability.formats,
    origin: copy.isFallback ? 'RULE_BASED' : 'AI_GENERATED',
    provider: {
      name: copy.provider,
      model: copy.model,
      isFallback: copy.isFallback,
      ...(copy.notice ? { notice: copy.notice } : {}),
    },
    // The generated fields, taken from the one structured response.
    angle: copy.data.slogan || copy.data.headline,
    hook: copy.data.shortText || copy.data.headline,
    headline: copy.data.headline,
    primaryText: copy.data.primaryText || copy.data.caption,
    callToAction: copy.data.cta,
    visualConcept: copy.data.longText || copy.data.caption,
    offerFraming: input.offer ?? null,
    hashtags: tags.data,
    /*
     * Relevance, never "best performing". No hashtag performance data is
     * fetched from any platform, so calling these top performers would be a
     * claim with nothing behind it. §19.
     */
    hashtagBasis: 'RELEVANCE',
    testingVariations: [
      copy.data.shortText,
      copy.data.slogan,
      copy.data.headline,
    ].filter((value, index, all) => value && all.indexOf(value) === index).slice(0, 3),
    limitations,
  };
}

/** Whether a model is configured at all — surfaced so the UI can say so. */
export function briefProviderStatus() {
  return aiStatus();
}
