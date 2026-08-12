/**
 * OpenAI provider. Used only when OPENAI_API_KEY is set.
 *
 * Responses come back as JSON and are parsed through the zod schemas in
 * `schemas.ts` before anything is returned. A malformed response throws, and the
 * facade falls back to the local generator rather than persisting garbage.
 */

import OpenAI from 'openai';
import { env } from '../../env.js';
import type { BrandContext, ContentRequest } from './context.js';
import { platformRule } from './context.js';
import type { CampaignFacts } from './facts.js';
import { analysisSchema, generatedCopySchema, type Analysis, type GeneratedCopy } from './schemas.js';

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) client = new OpenAI({ apiKey: env.OPENAI_API_KEY, timeout: 45_000, maxRetries: 1 });
  return client;
}

const COPY_SYSTEM = `You are a senior marketing copywriter working inside a marketing platform.
You write copy for a specific brand using only the brand context supplied.

Rules:
- Never invent facts, statistics, prices, awards or claims that are not in the brand context.
- Never use any word listed in forbiddenWords.
- Write in the requested language only. For Arabic, write natural Modern Standard Arabic suited to marketing, not a translation of English idiom.
- Respect the platform's character limits and conventions.
- Return JSON only, matching the requested shape exactly.`;

const ANALYSIS_SYSTEM = `You are a marketing analyst reviewing campaign performance.
You are given a JSON object of measured figures. That object is your only source of truth.

Rules:
- Never state a number that is not present in the supplied figures. Do not estimate, extrapolate or round into a new number.
- Everything you propose is a recommendation for a human to weigh, not an instruction.
- Be specific about which platform or campaign each point refers to.
- If the data is too thin to support a conclusion, say so.
- Return JSON only, matching the requested shape exactly.`;

function brandBlock(brand: BrandContext, request: ContentRequest): string {
  const rule = platformRule(request.platform);
  return JSON.stringify(
    {
      brand,
      request: {
        platform: request.platform,
        contentType: request.contentType,
        language: request.language === 'AR' ? 'Arabic' : 'English',
        tone: request.tone ?? brand.toneOfVoice ?? 'confident',
        productOrService: request.productService,
        offer: request.offer,
        audience: request.audience ?? brand.targetAudience,
      },
      platformRules: { maxCaptionCharacters: rule.captionMax, hashtagCount: rule.hashtags, guidance: rule.note },
      requiredShape: {
        headline: 'string',
        caption: 'string',
        primaryText: 'string',
        shortText: 'string',
        longText: 'string',
        slogan: 'string',
        cta: 'string',
        hashtags: ['string'],
        keywords: ['string'],
      },
    },
    null,
    2,
  );
}

async function complete(system: string, user: string): Promise<unknown> {
  const response = await getClient().chat.completions.create({
    model: env.OPENAI_MODEL,
    temperature: 0.7,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });

  const text = response.choices[0]?.message?.content;
  if (!text) throw new Error('OpenAI returned an empty response');
  return JSON.parse(text);
}

export async function openAiCopy(brand: BrandContext, request: ContentRequest): Promise<GeneratedCopy> {
  const raw = await complete(COPY_SYSTEM, brandBlock(brand, request));
  return generatedCopySchema.parse(raw);
}

export async function openAiHashtags(
  brand: BrandContext,
  request: ContentRequest,
  limit: number,
): Promise<string[]> {
  const raw = await complete(
    COPY_SYSTEM,
    `${brandBlock(brand, request)}\n\nReturn only {"hashtags": [...]} with at most ${limit} hashtags, each starting with #.`,
  );
  const parsed = generatedCopySchema.partial().parse(raw);
  return (parsed.hashtags ?? []).slice(0, limit);
}

export async function openAiAnalysis(facts: CampaignFacts): Promise<Analysis> {
  const raw = await complete(
    ANALYSIS_SYSTEM,
    JSON.stringify(
      {
        figures: facts,
        requiredShape: {
          summary: 'string',
          working: ['string'],
          failing: ['string'],
          recommendations: [{ title: 'string', detail: 'string', impact: 'high|medium|low', area: 'budget|creative|audience|platform|scheduling|measurement' }],
          nextActions: ['string'],
        },
      },
      null,
      2,
    ),
  );
  return analysisSchema.parse(raw);
}
