import { describe, expect, it } from 'vitest';
import { ReviewCategory, ReviewSentiment } from '@prisma/client';

import {
  analyzeReview, categorize, clusterComplaints, complaintKeyFor, sentimentOf, REPEAT_THRESHOLD,
} from '../src/services/google/analyze.js';
import { auditLocation, auditNap, unsupported } from '../src/services/google/seo.js';
import {
  authorizationUrl, exchangeCode, googleConfig, googleConfigured, listLocations, validateToken,
} from '../src/services/integrations/google.js';
import { listReviews, publishReply } from '../src/services/google/reviews.js';
import type { FetchLike } from '../src/services/integrations/meta.js';

function fetchSequence(responses: Array<{ body: unknown; status?: number }>) {
  const seen: Array<{ url: string; init: { method?: string; body?: unknown; headers?: Record<string, string> } }> = [];
  let call = 0;
  const fetchImpl = (async (url: string, init?: unknown) => {
    seen.push({ url, init: (init ?? {}) as { method?: string; body?: unknown } });
    const resp = responses[call++] ?? { body: {}, status: 500 };
    const status = resp.status ?? 200;
    return {
      ok: status < 400,
      status,
      json: async () => resp.body,
      text: async () => JSON.stringify(resp.body),
    };
  }) as unknown as FetchLike;
  return { fetchImpl, seen };
}

const env = {
  GOOGLE_CLIENT_ID: 'client-1',
  GOOGLE_CLIENT_SECRET: 'secret-1',
  GOOGLE_REDIRECT_URI: 'https://app.example.com/api/integrations/google/callback',
} as NodeJS.ProcessEnv;

describe('Google OAuth adapter', () => {
  it('reports missing configuration by variable name', () => {
    expect(googleConfigured({} as NodeJS.ProcessEnv)).toBe(false);
    expect(() => googleConfig({} as NodeJS.ProcessEnv)).toThrowError(/GOOGLE_CLIENT_ID/);
  });

  it('always asks for offline access and a fresh consent', () => {
    /*
     * The whole reason this integration survives past an hour. Without both
     * parameters Google issues no refresh token on a re-connection, and the
     * integration dies quietly the next morning.
     */
    const url = new URL(authorizationUrl({ config: googleConfig(env), state: 'state-1' }));

    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('scope')).toContain('business.manage');
    expect(url.searchParams.get('state')).toBe('state-1');
  });

  it('refuses a token response with no refresh token', async () => {
    // Better to fail while the operator is looking at the connect screen than
    // to store a credential that stops working in an hour with no way back.
    const { fetchImpl } = fetchSequence([
      { body: { access_token: 'a', expires_in: 3600, scope: 'openid' } },
    ]);

    await expect(
      exchangeCode({ config: googleConfig(env), code: 'c', fetchImpl }),
    ).rejects.toThrowError(/refresh token/i);
  });

  it('records the granted scopes rather than the requested ones', async () => {
    const { fetchImpl } = fetchSequence([
      {
        body: {
          access_token: 'a', refresh_token: 'r', expires_in: 3600,
          // Consent given for identity but not for Business Profile.
          scope: 'openid https://www.googleapis.com/auth/userinfo.email',
        },
      },
    ]);

    const tokens = await exchangeCode({
      config: googleConfig(env), code: 'c', fetchImpl, now: new Date('2026-01-01T00:00:00Z'),
    });

    expect(tokens.refreshToken).toBe('r');
    expect(tokens.expiresAt?.toISOString()).toBe('2026-01-01T01:00:00.000Z');
    expect(tokens.scopes).not.toContain('https://www.googleapis.com/auth/business.manage');
  });

  it('treats a Google API error envelope as a failure', async () => {
    const { fetchImpl } = fetchSequence([
      { body: { error: { code: 403, message: 'Request had insufficient authentication scopes.' } }, status: 403 },
    ]);

    await expect(
      validateToken({ accessToken: 'a', fetchImpl }),
    ).rejects.toThrowError(/insufficient authentication scopes/);
  });

  it('pages through every location rather than stopping at the first page', async () => {
    // A franchise with more branches than one page is exactly the case an
    // un-paged read gets silently wrong.
    const { fetchImpl, seen } = fetchSequence([
      { body: { locations: [{ name: 'locations/1', title: 'Riyadh' }], nextPageToken: 'p2' } },
      { body: { locations: [{ name: 'locations/2', title: 'Jeddah' }] } },
    ]);

    const locations = await listLocations({ accessToken: 'a', accountName: 'accounts/9', fetchImpl });

    expect(locations.map((entry) => entry.title)).toEqual(['Riyadh', 'Jeddah']);
    expect(seen).toHaveLength(2);
    expect(seen[0]!.url).toContain('readMask=');
  });
});

describe('Google reviews — reading', () => {
  const review = (overrides: Record<string, unknown> = {}) => ({
    reviewId: 'rev-1',
    reviewer: { displayName: 'Sara' },
    starRating: 'ONE',
    comment: 'The waiter was rude and we waited an hour.',
    createTime: '2026-01-10T12:00:00Z',
    ...overrides,
  });

  it('maps star words to numbers and carries an existing reply', async () => {
    const { fetchImpl } = fetchSequence([
      {
        body: {
          reviews: [review({
            starRating: 'FIVE',
            reviewReply: { comment: 'Thank you!', updateTime: '2026-01-11T09:00:00Z' },
          })],
        },
      },
    ]);

    const reviews = await listReviews({
      accessToken: 'a', accountName: 'accounts/9', locationName: 'locations/1', fetchImpl,
    });

    expect(reviews[0]!.rating).toBe(5);
    expect(reviews[0]!.existingReply?.comment).toBe('Thank you!');
  });

  it('skips a review whose rating cannot be read rather than defaulting it', async () => {
    // Storing an unreadable rating as 0 or 3 would put a number Google never
    // said into an average shown to the owner.
    const { fetchImpl } = fetchSequence([
      { body: { reviews: [review({ starRating: 'STAR_RATING_UNSPECIFIED' }), review({ reviewId: 'rev-2' })] } },
    ]);

    const reviews = await listReviews({
      accessToken: 'a', accountName: 'accounts/9', locationName: 'locations/1', fetchImpl,
    });

    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.externalId).toBe('rev-2');
  });
});

describe('Google reviews — replying', () => {
  it('PUTs the exact approved text', async () => {
    const { fetchImpl, seen } = fetchSequence([{ body: { updateTime: '2026-01-12T10:00:00Z' } }]);

    await publishReply({
      accessToken: 'a',
      accountName: 'accounts/9',
      locationName: 'locations/1',
      reviewExternalId: 'rev-1',
      comment: '  We are sorry about the wait.  ',
      fetchImpl,
    });

    // PUT, not POST: a reply is a singleton on the review, which is what makes
    // a retry safe rather than a second public comment.
    expect(seen[0]!.init.method).toBe('PUT');
    expect(seen[0]!.url).toContain('/reviews/rev-1/reply');
    expect(JSON.parse(String(seen[0]!.init.body)).comment).toBe('We are sorry about the wait.');
  });

  it('refuses to publish an empty reply', async () => {
    const { fetchImpl, seen } = fetchSequence([]);

    await expect(publishReply({
      accessToken: 'a', accountName: 'accounts/9', locationName: 'locations/1',
      reviewExternalId: 'rev-1', comment: '   ', fetchImpl,
    })).rejects.toThrowError(/cannot be empty/);

    // Nothing reached Google.
    expect(seen).toHaveLength(0);
  });
});

describe('Review analysis', () => {
  it('derives sentiment from the star rating, not the words', () => {
    // The rating is the customer's own verdict and cannot drift.
    expect(sentimentOf(5)).toBe(ReviewSentiment.POSITIVE);
    expect(sentimentOf(3)).toBe(ReviewSentiment.NEUTRAL);
    expect(sentimentOf(1)).toBe(ReviewSentiment.NEGATIVE);
  });

  it('files a review under what it is about, in either language', () => {
    expect(categorize('The waiter was rude', ReviewSentiment.NEGATIVE)).toBe(ReviewCategory.STAFF);
    expect(categorize('النادل كان وقح', ReviewSentiment.NEGATIVE)).toBe(ReviewCategory.STAFF);
    expect(categorize('The food was cold', ReviewSentiment.NEGATIVE)).toBe(ReviewCategory.PRODUCT);
    expect(categorize('الطعام بارد', ReviewSentiment.NEGATIVE)).toBe(ReviewCategory.PRODUCT);
    expect(categorize('Way too expensive', ReviewSentiment.NEGATIVE)).toBe(ReviewCategory.PRICING);
  });

  it('treats a question as a question whatever it is about', () => {
    // It needs an answer, not an apology.
    expect(categorize('Do you open on Fridays?', ReviewSentiment.NEUTRAL)).toBe(ReviewCategory.QUESTION);
    expect(categorize('هل لديكم توصيل؟', ReviewSentiment.NEUTRAL)).toBe(ReviewCategory.QUESTION);
  });

  it('files a bare rating without inventing a subject', () => {
    expect(categorize(null, ReviewSentiment.POSITIVE)).toBe(ReviewCategory.PRAISE);
    expect(categorize('', ReviewSentiment.NEGATIVE)).toBe(ReviewCategory.OTHER);
  });

  it('does not count a happy review as a complaint', () => {
    /*
     * A five-star review that mentions parking is not a parking complaint.
     * Counting it as one is how a "repeated complaint" alert fires about
     * something customers are perfectly happy with.
     */
    const happy = analyzeReview({ rating: 5, comment: 'Great food, easy parking' });
    expect(happy.sentiment).toBe(ReviewSentiment.POSITIVE);
    expect(happy.complaintKey).toBeNull();

    const unhappy = analyzeReview({ rating: 2, comment: 'No parking anywhere' });
    expect(unhappy.complaintKey).toBe(ReviewCategory.LOCATION);
  });

  it('never counts praise or a question as a complaint', () => {
    expect(complaintKeyFor(ReviewCategory.PRAISE, ReviewSentiment.NEUTRAL)).toBeNull();
    expect(complaintKeyFor(ReviewCategory.QUESTION, ReviewSentiment.NEGATIVE)).toBeNull();
  });
});

describe('Repeated complaints', () => {
  const row = (id: string, key: string | null, day: number) => ({
    id,
    complaintKey: key,
    category: (key as ReviewCategory) ?? null,
    createTime: new Date(Date.UTC(2026, 0, day)),
  });

  it('reports a cause only once it recurs', () => {
    const below = clusterComplaints([row('1', 'STAFF', 1), row('2', 'STAFF', 2)]);
    expect(below).toHaveLength(0);

    const at = clusterComplaints([row('1', 'STAFF', 1), row('2', 'STAFF', 2), row('3', 'STAFF', 3)]);
    expect(at).toHaveLength(1);
    expect(at[0]!.count).toBe(REPEAT_THRESHOLD);
  });

  it('groups by cause and orders by how often each recurs', () => {
    const clusters = clusterComplaints([
      row('1', 'STAFF', 1), row('2', 'STAFF', 2), row('3', 'STAFF', 3), row('4', 'STAFF', 4),
      row('5', 'PRICING', 5), row('6', 'PRICING', 6), row('7', 'PRICING', 7),
      row('8', null, 8),
    ]);

    expect(clusters.map((entry) => entry.key)).toEqual(['STAFF', 'PRICING']);
    expect(clusters[0]!.count).toBe(4);
    expect(clusters[0]!.firstSeen).toEqual(new Date(Date.UTC(2026, 0, 1)));
    expect(clusters[0]!.lastSeen).toEqual(new Date(Date.UTC(2026, 0, 4)));
  });
});

describe('Local SEO audit', () => {
  const location = (overrides: Record<string, unknown> = {}) => ({
    id: 'loc-1',
    title: 'Test Kitchen',
    addressLines: ['1 King Fahd Road'],
    locality: 'Riyadh',
    phone: '+966500000000',
    websiteUri: 'https://testkitchen.example',
    primaryCategory: 'Restaurant',
    storeCode: 'RUH-01',
    ...overrides,
  } as Parameters<typeof auditLocation>[0]);

  it('scores a complete profile at 100 with nothing to fix', () => {
    const audit = auditLocation(location());
    expect(audit.completeness).toBe(100);
    expect(audit.findings.every((finding) => finding.severity === 'OK')).toBe(true);
  });

  it('treats a missing address or phone as critical, the rest as warnings', () => {
    // Address and phone are how a customer reaches the business at all; the
    // others cost visibility rather than reachability.
    const audit = auditLocation(location({ phone: null, websiteUri: null }));

    const phone = audit.findings.find((finding) => finding.key === 'phone');
    const website = audit.findings.find((finding) => finding.key === 'website');

    expect(phone?.severity).toBe('CRITICAL');
    expect(website?.severity).toBe('WARNING');
    expect(audit.completeness).toBeLessThan(100);
  });

  it('flags branches that publish different brand names', () => {
    const findings = auditNap([
      location({ id: 'a', title: 'Test Kitchen' }),
      location({ id: 'b', title: 'TK Riyadh' }),
    ]);

    expect(findings.some((finding) => finding.field === 'name')).toBe(true);
  });

  it('does not flag differing addresses across branches', () => {
    // Branches are in different places. That is the point of branches.
    const findings = auditNap([
      location({ id: 'a', locality: 'Riyadh' }),
      location({ id: 'b', locality: 'Jeddah' }),
    ]);

    expect(findings).toHaveLength(0);
  });

  it('says nothing about consistency for a single branch', () => {
    expect(auditNap([location()])).toHaveLength(0);
  });

  it('names what Google has no API for, rather than omitting it', () => {
    /*
     * The honest half of Local SEO. A blank panel reads as "no data yet"; a
     * stated limit reads as what it is.
     */
    const keys = unsupported().map((entry) => entry.key);

    expect(keys).toContain('RANK_TRACKING');
    expect(keys).toContain('COMPETITOR_RANKS');
    expect(keys).toContain('KEYWORD_RESEARCH');
    for (const entry of unsupported()) {
      expect(entry.reason.length).toBeGreaterThan(20);
    }
  });
});
