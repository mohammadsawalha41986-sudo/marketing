/**
 * Structured shapes the AI layer is allowed to return. Every model response is
 * parsed through these before it reaches the database, so a malformed or
 * hallucinated shape fails closed instead of being persisted.
 */

import { z } from 'zod';

export const generatedCopySchema = z.object({
  headline: z.string().min(1).max(160),
  caption: z.string().min(1).max(2200),
  primaryText: z.string().min(1).max(3000),
  shortText: z.string().min(1).max(300),
  longText: z.string().min(1).max(6000),
  slogan: z.string().min(1).max(120),
  cta: z.string().min(1).max(80),
  hashtags: z.array(z.string().min(2).max(60)).max(30),
  keywords: z.array(z.string().min(2).max(60)).max(30),
});

export type GeneratedCopy = z.infer<typeof generatedCopySchema>;

/**
 * A public reply to a customer review.
 *
 * One field, and bounded: Google truncates long replies in the listing, and a
 * reply is the one AI output in this product that gets published under the
 * business's own name to a stranger. A tight shape is what stops a model
 * returning a marketing paragraph where two sentences were asked for.
 */
export const reviewReplySchema = z.object({
  reply: z.string().min(1).max(1500),
});

export type ReviewReply = z.infer<typeof reviewReplySchema>;

export const hashtagSetSchema = z.object({
  hashtags: z.array(z.string().min(2).max(60)).min(1).max(30),
});

export const analysisSchema = z.object({
  summary: z.string().min(1).max(1200),
  working: z.array(z.string().min(1).max(400)).max(8),
  failing: z.array(z.string().min(1).max(400)).max(8),
  recommendations: z
    .array(
      z.object({
        title: z.string().min(1).max(160),
        detail: z.string().min(1).max(600),
        // Kept qualitative on purpose: the model must not mint precise figures.
        impact: z.enum(['high', 'medium', 'low']),
        area: z.enum(['budget', 'creative', 'audience', 'platform', 'scheduling', 'measurement']),
      }),
    )
    .max(8),
  nextActions: z.array(z.string().min(1).max(300)).max(8),
});

export type Analysis = z.infer<typeof analysisSchema>;

/** Every AI result carries its provenance so the UI can label it truthfully. */
export interface AiResult<T> {
  data: T;
  provider: 'openai' | 'template';
  model: string;
  latencyMs: number;
  /** True when produced by the local generator rather than a language model. */
  isFallback: boolean;
  notice?: string;
}
