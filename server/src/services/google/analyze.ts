/**
 * What a review is about, and what to say back.
 *
 * Two rules run through this file.
 *
 * **Derived is labelled derived.** Google supplies a star rating and a body of
 * text; sentiment, category and complaint clustering are ours. They are stored
 * on our own columns, timestamped with `analyzedAt`, and never presented as
 * something the platform reported. Nothing here writes a number Google did not
 * give — the rating is copied, never adjusted, and no average is invented.
 *
 * **Nothing is published by this file.** `suggestReply` returns text. Putting
 * it in front of a customer is a separate, human-gated step in the route layer.
 * That separation is the whole safety property of the review workspace: the
 * generator physically cannot reach Google.
 *
 * Sentiment is derived from the star rating rather than from the words. The
 * rating is the customer's own explicit verdict — a deterministic signal that
 * needs no model, works identically in Arabic and English, and cannot drift.
 * Reading tone out of the text instead would introduce a second opinion that
 * disagrees with the stars in exactly the cases that matter most.
 */

import { ReviewCategory, ReviewSentiment } from '@prisma/client';

import { brandContext, generateReviewReply, type BrandContext } from '../ai/index.js';

/** Star rating → sentiment. The customer's own verdict, not a model's. */
export function sentimentOf(rating: number): ReviewSentiment {
  if (rating >= 4) return ReviewSentiment.POSITIVE;
  if (rating <= 2) return ReviewSentiment.NEGATIVE;
  return ReviewSentiment.NEUTRAL;
}

/**
 * Keyword sets per category, in both languages the product serves.
 *
 * Deliberately a lexicon rather than a model call. Categorisation runs over
 * every review on every sync, an LLM call per review would cost real money for
 * a five-word verdict, and a keyword hit is explainable to an operator who asks
 * why a review was filed under Staff. Where nothing matches, the answer is
 * OTHER rather than a guess.
 */
const LEXICON: Array<{ category: ReviewCategory; terms: string[] }> = [
  {
    category: ReviewCategory.STAFF,
    terms: [
      'staff', 'waiter', 'waitress', 'server', 'manager', 'rude', 'friendly', 'polite',
      'employee', 'cashier', 'team',
      'الموظف', 'الموظفة', 'النادل', 'الطاقم', 'المدير', 'وقح', 'لطيف', 'الخدمة السيئة',
    ],
  },
  {
    category: ReviewCategory.PRODUCT,
    terms: [
      'food', 'meal', 'dish', 'burger', 'pizza', 'coffee', 'taste', 'tasty', 'flavour',
      'flavor', 'cold', 'undercooked', 'stale', 'fresh', 'portion', 'quality',
      'الطعام', 'الأكل', 'الوجبة', 'الطبق', 'القهوة', 'الطعم', 'بارد', 'لذيذ', 'الجودة',
    ],
  },
  {
    category: ReviewCategory.PRICING,
    terms: [
      'price', 'expensive', 'overpriced', 'cheap', 'value', 'cost', 'bill', 'charge',
      'السعر', 'غالي', 'مكلف', 'رخيص', 'الفاتورة', 'الأسعار',
    ],
  },
  {
    category: ReviewCategory.LOCATION,
    terms: [
      'parking', 'location', 'clean', 'dirty', 'toilet', 'bathroom', 'seating', 'noisy',
      'crowded', 'atmosphere', 'ambience',
      'الموقع', 'المواقف', 'نظيف', 'وسخ', 'الحمام', 'مزدحم', 'الأجواء',
    ],
  },
  {
    category: ReviewCategory.SERVICE,
    terms: [
      'wait', 'waiting', 'slow', 'late', 'delay', 'delivery', 'order', 'service',
      'queue', 'quick', 'fast',
      'انتظار', 'بطيء', 'تأخير', 'التوصيل', 'الطلب', 'الخدمة', 'سريع',
    ],
  },
];

const QUESTION_MARKERS = ['?', '؟', 'do you', 'are you', 'is there', 'can i', 'هل ', 'متى', 'كم '];

/**
 * What this review is about.
 *
 * Order matters. A question is a question whatever it is about, because it
 * needs an answer rather than an apology. A specific complaint beats the
 * generic COMPLAINT bucket, so "Staff" is more useful than "Complaint" when the
 * words say which. A positive review with no specific subject is PRAISE.
 */
export function categorize(comment: string | null, sentiment: ReviewSentiment): ReviewCategory {
  const text = (comment ?? '').toLowerCase().trim();

  if (text.length === 0) {
    // A bare star rating carries no subject to categorise.
    return sentiment === ReviewSentiment.POSITIVE ? ReviewCategory.PRAISE : ReviewCategory.OTHER;
  }

  if (QUESTION_MARKERS.some((marker) => text.includes(marker))) return ReviewCategory.QUESTION;

  const hit = LEXICON.find((entry) => entry.terms.some((term) => text.includes(term)));
  if (hit) return hit.category;

  if (sentiment === ReviewSentiment.POSITIVE) return ReviewCategory.PRAISE;
  if (sentiment === ReviewSentiment.NEGATIVE) return ReviewCategory.COMPLAINT;
  return ReviewCategory.OTHER;
}

/**
 * The bucket a complaint counts toward, or null when it is not a complaint.
 *
 * Only negative and neutral reviews get a key: a five-star review that mentions
 * parking is not a parking complaint, and counting it as one is how a
 * "repeated complaint" alert fires about something customers are happy with.
 */
export function complaintKeyFor(
  category: ReviewCategory,
  sentiment: ReviewSentiment,
): string | null {
  if (sentiment === ReviewSentiment.POSITIVE) return null;
  if (category === ReviewCategory.PRAISE || category === ReviewCategory.QUESTION) return null;
  return category;
}

export interface ReviewAnalysis {
  sentiment: ReviewSentiment;
  category: ReviewCategory;
  complaintKey: string | null;
}

export function analyzeReview(input: { rating: number; comment: string | null }): ReviewAnalysis {
  const sentiment = sentimentOf(input.rating);
  const category = categorize(input.comment, sentiment);
  return { sentiment, category, complaintKey: complaintKeyFor(category, sentiment) };
}

// ------------------------------------------------------ repeated complaints

export interface ComplaintCluster {
  key: string;
  category: ReviewCategory;
  count: number;
  /** The most recent examples, for an operator deciding whether it is real. */
  sampleReviewIds: string[];
  firstSeen: Date;
  lastSeen: Date;
}

/** Below this, two unhappy customers is not yet a pattern worth alerting on. */
export const REPEAT_THRESHOLD = 3;

/**
 * Group complaints by cause and report the ones that recur.
 *
 * Counting only, over rows already analysed. It reports what was observed and
 * never asserts a trend beyond it: three parking complaints is three parking
 * complaints, not "parking is getting worse".
 */
export function clusterComplaints(
  reviews: Array<{ id: string; complaintKey: string | null; category: ReviewCategory | null; createTime: Date }>,
  threshold = REPEAT_THRESHOLD,
): ComplaintCluster[] {
  const buckets = new Map<string, ComplaintCluster>();

  for (const review of reviews) {
    if (!review.complaintKey) continue;

    const existing = buckets.get(review.complaintKey);
    if (existing) {
      existing.count += 1;
      if (existing.sampleReviewIds.length < 5) existing.sampleReviewIds.push(review.id);
      if (review.createTime < existing.firstSeen) existing.firstSeen = review.createTime;
      if (review.createTime > existing.lastSeen) existing.lastSeen = review.createTime;
    } else {
      buckets.set(review.complaintKey, {
        key: review.complaintKey,
        category: review.category ?? ReviewCategory.OTHER,
        count: 1,
        sampleReviewIds: [review.id],
        firstSeen: review.createTime,
        lastSeen: review.createTime,
      });
    }
  }

  return [...buckets.values()]
    .filter((cluster) => cluster.count >= threshold)
    .sort((a, b) => b.count - a.count);
}

// -------------------------------------------------------------- suggestion

export interface ReplySuggestion {
  text: string;
  provider: 'openai' | 'template';
  notice?: string;
}

/**
 * A reply the business could send, in the brand's own voice and language.
 *
 * Returns text and nothing else. It cannot publish, and the route that can
 * publish will not accept a suggestion — only text a person has approved. That
 * is deliberate: a generator with a path to Google is one bug away from
 * answering a customer in the brand's name without anyone reading it.
 */
export async function suggestReply(input: {
  brand: Parameters<typeof brandContext>[0] | null;
  businessName: string;
  language: 'AR' | 'EN';
  rating: number;
  comment: string | null;
  category: ReviewCategory;
  sentiment: ReviewSentiment;
  reviewerName?: string | null;
}): Promise<ReplySuggestion> {
  /*
   * A client without Brand DNA still gets a reply, it is just plainer. The
   * fallback carries the business name and nothing invented — no tone, no
   * personality, no claims the brand never made.
   */
  const context: BrandContext = input.brand
    ? brandContext(input.brand)
    : {
      businessName: input.businessName,
      personality: [],
      values: [],
      products: [],
      services: [],
      usps: [],
      offers: [],
      keywords: [],
      forbiddenWords: [],
    };

  const result = await generateReviewReply(context, {
    rating: input.rating,
    comment: input.comment,
    category: input.category.toLowerCase().replace(/_/g, ' '),
    reviewerName: input.reviewerName,
    language: input.language,
  });

  return { text: result.data.reply, provider: result.provider, notice: result.notice };
}
