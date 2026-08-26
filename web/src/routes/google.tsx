/**
 * The Google workspace: overview, locations, reviews and the local SEO audit.
 *
 * The reviews screen is the one that carries a real safety property, and the UI
 * makes it visible rather than implicit. A suggested reply is marked as written
 * by AI and unread; approving it is a separate button that sends the text
 * actually shown in the box, so an operator who edits the wording approves what
 * they can see; and only an approved reply can be published. The publish button
 * does not exist until a person has approved something.
 *
 * Everywhere a Google product is not connected in this phase — Search Console,
 * GA4, Ads reporting — the workspace says so by name. A dashboard that silently
 * omits a panel reads as "no traffic"; one that says "not connected" reads as
 * what it is.
 */

import { useCallback, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  AlertTriangle, CheckCircle2, MapPin, MessageSquare, Plug, RefreshCw, Send,
  Sparkles, Star, TriangleAlert,
} from 'lucide-react';

import { api, qs, type Paginated } from '../lib/api';
import { useQuery, useDebounced } from '../lib/hooks';
import { useI18n, type TranslationKey } from '../lib/i18n';
import { useRestaurant } from '../lib/restaurant';
import { date, dateTime, humanize, num, pct } from '../lib/format';
import { cn } from '../lib/utils';
import {
  Badge, Button, Card, CardSkeleton, EmptyState, ErrorState, Input, Pagination,
  PageHeader, Select, Textarea, useToast,
} from '../components/ui';

// ------------------------------------------------------------------- types

type Sentiment = 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE';
type ReplyStatus = 'NONE' | 'SUGGESTED' | 'PENDING_APPROVAL' | 'PUBLISHED' | 'FAILED';

interface GoogleStatus {
  connected: boolean;
  status: string | null;
  accountName: string | null;
  hasRefreshToken: boolean;
  scopes: string[];
  selectedAccounts: Array<{ id: string; name: string; externalId: string }>;
  lastError: string | null;
}

interface LocationRow {
  id: string;
  title: string;
  storeCode: string | null;
  addressLines: string[];
  locality: string | null;
  region: string | null;
  phone: string | null;
  websiteUri: string | null;
  mapsUri: string | null;
  primaryCategory: string | null;
  syncedAt: string | null;
  client: { id: string; businessName: string };
  _count: { reviews: number };
}

interface ReviewRow {
  id: string;
  reviewerName: string | null;
  rating: number;
  comment: string | null;
  createTime: string;
  sentiment: Sentiment | null;
  category: string | null;
  aiSuggestion: string | null;
  aiProvider: string | null;
  replyStatus: ReplyStatus;
  replyText: string | null;
  repliedAt: string | null;
  replyError: string | null;
  approvedBy: { id: string; name: string } | null;
  location: { id: string; title: string; locality: string | null };
}

interface Metric { value: number | null; source: string }

interface Overview {
  locations: Metric;
  reviews: Metric;
  newReviews30d: Metric;
  averageRating: Metric;
  responseRate: Metric;
  awaitingReply: Metric;
  repeatedComplaints: { value: Array<{ key: string; count: number }>; source: string };
  notConnected: Array<{ key: string; title: string; reason: string }>;
}

// ------------------------------------------------------------------ shared

const SENTIMENT_TONE: Record<Sentiment, 'ok' | 'warn' | 'danger'> = {
  POSITIVE: 'ok', NEUTRAL: 'warn', NEGATIVE: 'danger',
};

const REPLY_TONE: Record<ReplyStatus, 'neutral' | 'brand' | 'warn' | 'accent' | 'danger'> = {
  NONE: 'neutral', SUGGESTED: 'brand', PENDING_APPROVAL: 'warn',
  PUBLISHED: 'accent', FAILED: 'danger',
};

function Stars({ rating }: { rating: number }) {
  return (
    <span className="inline-flex items-center gap-0.5" dir="ltr" aria-label={`${rating} of 5`}>
      {[1, 2, 3, 4, 5].map((star) => (
        <Star
          key={star}
          className={cn('h-3.5 w-3.5', star <= rating ? 'fill-warn text-warn' : 'text-muted/40')}
        />
      ))}
    </span>
  );
}

/** A figure that names where it came from, as the spec requires. */
function SourceStat({
  label, value, source, suffix,
}: { label: string; value: string; source: string; suffix?: string }) {
  const { t } = useI18n();
  return (
    <Card className="p-3.5">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 text-[22px] font-semibold leading-none text-fg" dir="ltr">
        {value}{suffix ?? ''}
      </p>
      <p className="mt-1.5 text-[10.5px] text-muted">
        {t('google.source')}: {t(`google.src.${source}` as TranslationKey)}
      </p>
    </Card>
  );
}

/** Shown wherever Google is not connected for the selected restaurant. */
function NotConnected() {
  const { t } = useI18n();
  return (
    <EmptyState
      icon={Plug}
      title={t('google.notConnectedTitle')}
      body={t('google.notConnectedBody')}
      action={<Link to="/app/integrations"><Button icon={Plug}>{t('nav.integrations')}</Button></Link>}
    />
  );
}

function useGoogleStatus(clientId: string | null) {
  return useQuery<GoogleStatus>(clientId ? `/google/status${qs({ clientId })}` : null, [clientId]);
}

// ---------------------------------------------------------------- overview

export function GoogleOverviewPage() {
  const { currentId: clientId, current } = useRestaurant();
  const { lang, t } = useI18n();
  const status = useGoogleStatus(clientId);
  const overview = useQuery<Overview>(clientId ? `/google/overview${qs({ clientId })}` : null, [clientId]);

  if (!clientId) {
    return <EmptyState icon={MapPin} title={t('library.pickRestaurantTitle')} body={t('library.pickRestaurant')} />;
  }

  return (
    <>
      <PageHeader title={t('google.overviewTitle')} subtitle={current?.businessName} />

      {status.loading ? (
        <CardSkeleton rows={3} />
      ) : !status.data?.connected ? (
        <NotConnected />
      ) : overview.loading ? (
        <CardSkeleton rows={4} />
      ) : overview.error ? (
        <ErrorState message={overview.error} onRetry={overview.refetch} />
      ) : overview.data ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <SourceStat
              label={t('google.locations')}
              value={num(overview.data.locations.value, lang)}
              source={overview.data.locations.source}
            />
            <SourceStat
              label={t('google.reviews')}
              value={num(overview.data.reviews.value, lang)}
              source={overview.data.reviews.source}
            />
            <SourceStat
              label={t('google.newReviews')}
              value={num(overview.data.newReviews30d.value, lang)}
              source={overview.data.newReviews30d.source}
            />
            <SourceStat
              // null, not 0: a restaurant with no reviews has no rating.
              label={t('google.averageRating')}
              value={overview.data.averageRating.value === null
                ? t('google.noData')
                : overview.data.averageRating.value.toFixed(2)}
              source={overview.data.averageRating.source}
            />
            <SourceStat
              label={t('google.responseRate')}
              value={overview.data.responseRate.value === null
                ? t('google.noData')
                : pct(overview.data.responseRate.value, 0)}
              source={overview.data.responseRate.source}
            />
            <SourceStat
              label={t('google.awaitingReply')}
              value={num(overview.data.awaitingReply.value, lang)}
              source={overview.data.awaitingReply.source}
            />
          </div>

          {overview.data.repeatedComplaints.value.length > 0 ? (
            <Card className="mt-4 p-3.5">
              <p className="inline-flex items-center gap-1.5 text-[13px] font-semibold">
                <TriangleAlert className="h-4 w-4 text-warn" />
                {t('google.repeated')}
              </p>
              <ul className="mt-2 space-y-1">
                {overview.data.repeatedComplaints.value.map((cluster) => (
                  <li key={cluster.key} className="flex items-center justify-between text-[12.5px]">
                    <span>{t(`google.cat.${cluster.key}` as TranslationKey)}</span>
                    <span className="tabular text-muted" dir="ltr">{cluster.count}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[11px] text-muted">{t('google.repeatedNote')}</p>
            </Card>
          ) : null}

          {/* Named rather than omitted — a missing panel reads as "no data". */}
          <Card className="mt-4 p-3.5">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">
              {t('google.notInThisPhase')}
            </p>
            <ul className="mt-2 space-y-1.5">
              {overview.data.notConnected.map((entry) => (
                <li key={entry.key} className="text-[12px]">
                  <span className="font-medium">{entry.title}</span>
                  <span className="text-muted"> — {entry.reason}</span>
                </li>
              ))}
            </ul>
          </Card>
        </>
      ) : null}
    </>
  );
}

// --------------------------------------------------------------- locations

export function GoogleLocationsPage() {
  const { currentId: clientId, current } = useRestaurant();
  const { lang, t } = useI18n();
  const { push } = useToast();
  const status = useGoogleStatus(clientId);
  const [syncing, setSyncing] = useState(false);

  const locations = useQuery<{ locations: LocationRow[] }>(
    clientId ? `/google/locations${qs({ clientId })}` : null,
    [clientId],
  );

  const sync = async () => {
    if (!clientId) return;
    setSyncing(true);
    try {
      const result = await api.post<{ synced: number }>('/google/locations/sync', { clientId });
      push({ tone: 'success', title: t('google.synced').replace('{n}', String(result.synced)) });
      locations.refetch();
    } catch (error) {
      push({ tone: 'error', title: t('google.syncFailed'), body: error instanceof Error ? error.message : undefined });
    } finally {
      setSyncing(false);
    }
  };

  if (!clientId) {
    return <EmptyState icon={MapPin} title={t('library.pickRestaurantTitle')} body={t('library.pickRestaurant')} />;
  }

  return (
    <>
      <PageHeader
        title={t('google.locationsTitle')}
        subtitle={current?.businessName}
        action={
          status.data?.connected ? (
            <Button variant="secondary" icon={RefreshCw} loading={syncing} onClick={sync}>
              {t('google.syncLocations')}
            </Button>
          ) : null
        }
      />

      {status.loading ? (
        <CardSkeleton rows={3} />
      ) : !status.data?.connected ? (
        <NotConnected />
      ) : locations.loading ? (
        <CardSkeleton rows={3} />
      ) : locations.error ? (
        <ErrorState message={locations.error} onRetry={locations.refetch} />
      ) : (locations.data?.locations.length ?? 0) === 0 ? (
        <EmptyState
          icon={MapPin}
          title={t('google.noLocationsTitle')}
          body={t('google.noLocationsBody')}
          action={<Button icon={RefreshCw} loading={syncing} onClick={sync}>{t('google.syncLocations')}</Button>}
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {locations.data?.locations.map((location) => (
            <Card key={location.id} className="p-3.5">
              <div className="flex items-start justify-between gap-2">
                <p className="text-[14px] font-semibold" dir="auto">{location.title}</p>
                {location.storeCode ? (
                  <span className="rounded-full border border-line px-2 py-0.5 text-[10.5px] text-muted">
                    {location.storeCode}
                  </span>
                ) : null}
              </div>

              {location.primaryCategory ? (
                <p className="mt-0.5 text-[11.5px] text-muted" dir="auto">{location.primaryCategory}</p>
              ) : null}

              <address className="mt-2 not-italic text-[12px] leading-relaxed text-muted" dir="auto">
                {location.addressLines.join(', ')}
                {location.locality ? <><br />{location.locality}{location.region ? `, ${location.region}` : ''}</> : null}
              </address>

              <div className="mt-2 space-y-0.5 text-[11.5px]">
                {location.phone
                  ? <p dir="ltr">{location.phone}</p>
                  : <p className="text-danger">{t('google.noPhone')}</p>}
                {location.websiteUri
                  ? <p className="truncate text-brand" dir="ltr">{location.websiteUri}</p>
                  : <p className="text-warn">{t('google.noWebsite')}</p>}
              </div>

              <div className="mt-2.5 flex items-center justify-between border-t border-line pt-2 text-[11px] text-muted">
                <span>{num(location._count.reviews, lang)} {t('google.reviews')}</span>
                {location.syncedAt ? <span dir="ltr">{date(location.syncedAt, lang)}</span> : null}
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

// ----------------------------------------------------------------- reviews

export function GoogleReviewsPage() {
  const { currentId: clientId, current } = useRestaurant();
  const { lang, t } = useI18n();
  const { push } = useToast();
  const status = useGoogleStatus(clientId);

  const [sentiment, setSentiment] = useState('');
  const [replyStatus, setReplyStatus] = useState('');
  const [locationId, setLocationId] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const debounced = useDebounced(search, 300);

  const locations = useQuery<{ locations: LocationRow[] }>(
    clientId ? `/google/locations${qs({ clientId })}` : null,
    [clientId],
  );

  const path = clientId
    ? `/google/reviews${qs({
      clientId, sentiment: sentiment || undefined, replyStatus: replyStatus || undefined,
      locationId: locationId || undefined, search: debounced || undefined, page, pageSize: 20,
    })}`
    : null;

  const reviews = useQuery<Paginated<ReviewRow>>(path, [path]);

  if (!clientId) {
    return <EmptyState icon={MessageSquare} title={t('library.pickRestaurantTitle')} body={t('library.pickRestaurant')} />;
  }

  return (
    <>
      <PageHeader title={t('google.reviewsTitle')} subtitle={current?.businessName} />

      {status.loading ? (
        <CardSkeleton rows={3} />
      ) : !status.data?.connected ? (
        <NotConnected />
      ) : (
        <>
          <Card className="mb-3 p-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-[180px] flex-1">
                <Input
                  value={search}
                  onChange={(event) => { setSearch(event.target.value); setPage(1); }}
                  placeholder={t('common.search')}
                  aria-label={t('common.search')}
                />
              </div>

              <Select
                value={locationId}
                onChange={(event) => { setLocationId(event.target.value); setPage(1); }}
                aria-label={t('google.location')}
                className="w-auto"
              >
                <option value="">{t('google.allLocations')}</option>
                {locations.data?.locations.map((location) => (
                  <option key={location.id} value={location.id}>{location.title}</option>
                ))}
              </Select>

              <Select
                value={sentiment}
                onChange={(event) => { setSentiment(event.target.value); setPage(1); }}
                aria-label={t('google.sentiment')}
                className="w-auto"
              >
                <option value="">{t('google.allSentiment')}</option>
                {(['POSITIVE', 'NEUTRAL', 'NEGATIVE'] as const).map((entry) => (
                  <option key={entry} value={entry}>{t(`google.sent.${entry}` as TranslationKey)}</option>
                ))}
              </Select>

              <Select
                value={replyStatus}
                onChange={(event) => { setReplyStatus(event.target.value); setPage(1); }}
                aria-label={t('google.replyStatus')}
                className="w-auto"
              >
                <option value="">{t('google.allReplies')}</option>
                {(['NONE', 'SUGGESTED', 'PENDING_APPROVAL', 'PUBLISHED', 'FAILED'] as const).map((entry) => (
                  <option key={entry} value={entry}>{t(`google.reply.${entry}` as TranslationKey)}</option>
                ))}
              </Select>
            </div>
          </Card>

          {reviews.loading ? (
            <CardSkeleton rows={4} />
          ) : reviews.error ? (
            <ErrorState message={reviews.error} onRetry={reviews.refetch} />
          ) : (reviews.data?.items.length ?? 0) === 0 ? (
            <EmptyState
              icon={MessageSquare}
              title={t('google.noReviewsTitle')}
              body={t('google.noReviewsBody')}
            />
          ) : (
            <>
              <div className="space-y-2.5">
                {reviews.data?.items.map((review) => (
                  <ReviewCard
                    key={review.id}
                    review={review}
                    lang={lang}
                    onChanged={reviews.refetch}
                    push={push}
                  />
                ))}
              </div>
              <Pagination
                page={page}
                pages={reviews.data?.pagination.pages ?? 1}
                onChange={setPage}
              />
            </>
          )}
        </>
      )}
    </>
  );
}

/**
 * One review, and its reply workflow.
 *
 * The three states are visibly different because they mean different things:
 * a suggestion is marked as machine-written and unread, an approved reply names
 * the person who approved it, and only then does Publish appear.
 */
function ReviewCard({
  review, lang, onChanged, push,
}: {
  review: ReviewRow;
  lang: 'en' | 'ar';
  onChanged: () => void;
  push: ReturnType<typeof useToast>['push'];
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(review.replyText ?? review.aiSuggestion ?? '');
  const [busy, setBusy] = useState<string | null>(null);

  const run = useCallback(async (action: string, fn: () => Promise<unknown>) => {
    setBusy(action);
    try {
      await fn();
      onChanged();
    } catch (error) {
      push({ tone: 'error', title: t('google.actionFailed'), body: error instanceof Error ? error.message : undefined });
    } finally {
      setBusy(null);
    }
  }, [onChanged, push, t]);

  const suggest = () => run('suggest', async () => {
    const result = await api.post<{ review: { aiSuggestion: string } }>(
      `/google/reviews/${review.id}/suggest`, {},
    );
    setDraft(result.review.aiSuggestion);
  });

  const approve = () => run('approve', () =>
    // The text sent is the text on screen, so an edited suggestion is what gets
    // approved rather than whatever the model originally wrote.
    api.post(`/google/reviews/${review.id}/approve`, { text: draft.trim() }));

  const publish = () => run('publish', () => api.post(`/google/reviews/${review.id}/publish`, {}));

  const published = review.replyStatus === 'PUBLISHED';
  const approved = review.replyStatus === 'PENDING_APPROVAL';

  return (
    <Card className="p-3.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Stars rating={review.rating} />
            <span className="text-[13px] font-medium" dir="auto">
              {review.reviewerName ?? t('google.anonymous')}
            </span>
            {review.sentiment ? (
              <Badge tone={SENTIMENT_TONE[review.sentiment]} dot>
                {t(`google.sent.${review.sentiment}` as TranslationKey)}
              </Badge>
            ) : null}
            {review.category ? (
              <span className="rounded-full border border-line px-2 py-0.5 text-[10.5px] text-muted">
                {t(`google.cat.${review.category}` as TranslationKey)}
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-[11.5px] text-muted">
            <span dir="auto">{review.location.title}</span>
            {' · '}
            <span dir="ltr">{date(review.createTime, lang)}</span>
          </p>
        </div>

        <Badge tone={REPLY_TONE[review.replyStatus]} dot>
          {t(`google.reply.${review.replyStatus}` as TranslationKey)}
        </Badge>
      </div>

      {review.comment ? (
        <p className="mt-2 whitespace-pre-line text-[13px] leading-relaxed" dir="auto">{review.comment}</p>
      ) : (
        <p className="mt-2 text-[12.5px] italic text-muted">{t('google.ratingOnly')}</p>
      )}

      {/* ---------------------------------------------------------- reply */}
      {published ? (
        <div className="mt-3 rounded-lg border border-line bg-elevated/40 p-2.5">
          <p className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
            <CheckCircle2 className="h-3 w-3 text-ok" />
            {t('google.publishedReply')}
            {review.repliedAt ? <span className="font-normal" dir="ltr">· {dateTime(review.repliedAt, lang)}</span> : null}
          </p>
          <p className="mt-1.5 text-[12.5px] leading-relaxed" dir="auto">{review.replyText}</p>
        </div>
      ) : (
        <div className="mt-3">
          {review.aiSuggestion && !approved ? (
            <p className="mb-1.5 inline-flex items-center gap-1.5 text-[11px] text-brand">
              <Sparkles className="h-3 w-3" />
              {t('google.aiWrote')}
              {review.aiProvider ? ` (${review.aiProvider})` : ''}
              {' — '}
              {t('google.aiUnread')}
            </p>
          ) : null}

          {approved ? (
            <p className="mb-1.5 inline-flex items-center gap-1.5 text-[11px] text-ok">
              <CheckCircle2 className="h-3 w-3" />
              {t('google.approvedBy').replace('{name}', review.approvedBy?.name ?? '—')}
            </p>
          ) : null}

          <Textarea
            rows={3}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={t('google.replyPlaceholder')}
            dir="auto"
          />

          {review.replyError ? (
            <p className="mt-1.5 flex items-start gap-1.5 rounded-lg bg-danger/10 px-2 py-1.5 text-[11.5px] text-danger">
              <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
              <span dir="auto">{review.replyError}</span>
            </p>
          ) : null}

          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon={Sparkles}
              loading={busy === 'suggest'}
              onClick={suggest}
            >
              {t('google.suggest')}
            </Button>

            <Button
              variant="secondary"
              size="sm"
              icon={CheckCircle2}
              disabled={!draft.trim()}
              loading={busy === 'approve'}
              onClick={approve}
            >
              {approved ? t('google.reapprove') : t('google.approve')}
            </Button>

            {/* Only after a person approved. This is the gate, in the UI. */}
            {approved ? (
              <Button size="sm" icon={Send} loading={busy === 'publish'} onClick={publish}>
                {t('google.publish')}
              </Button>
            ) : null}
          </div>

          <p className="mt-1.5 text-[10.5px] text-muted">{t('google.approvalNote')}</p>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- local seo

interface AuditFinding {
  key: string;
  severity: 'CRITICAL' | 'WARNING' | 'OK';
  title: string;
  detail: string;
  action: string | null;
}

interface SeoAudit {
  locations: Array<{ locationId: string; title: string; completeness: number; findings: AuditFinding[] }>;
  nap: Array<{ field: string; severity: string; detail: string; values: string[] }>;
  unsupported: Array<{ key: string; title: string; reason: string }>;
}

export function GoogleSeoPage() {
  const { currentId: clientId, current } = useRestaurant();
  const { t } = useI18n();
  const status = useGoogleStatus(clientId);
  const audit = useQuery<SeoAudit>(clientId ? `/google/seo/audit${qs({ clientId })}` : null, [clientId]);

  const problems = useMemo(
    () => audit.data?.locations.flatMap((location) =>
      location.findings.filter((finding) => finding.severity !== 'OK').map((finding) => ({ location, finding }))) ?? [],
    [audit.data],
  );

  if (!clientId) {
    return <EmptyState icon={MapPin} title={t('library.pickRestaurantTitle')} body={t('library.pickRestaurant')} />;
  }

  return (
    <>
      <PageHeader title={t('google.seoTitle')} subtitle={current?.businessName} />

      {status.loading ? (
        <CardSkeleton rows={3} />
      ) : !status.data?.connected ? (
        <NotConnected />
      ) : audit.loading ? (
        <CardSkeleton rows={4} />
      ) : audit.error ? (
        <ErrorState message={audit.error} onRetry={audit.refetch} />
      ) : audit.data ? (
        <>
          {audit.data.locations.length === 0 ? (
            <EmptyState icon={MapPin} title={t('google.noLocationsTitle')} body={t('google.noLocationsBody')} />
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {audit.data.locations.map((location) => (
                  <Card key={location.locationId} className="p-3.5">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-[13.5px] font-semibold" dir="auto">{location.title}</p>
                      <span
                        className={cn(
                          'tabular text-[13px] font-semibold',
                          location.completeness >= 80 ? 'text-ok'
                            : location.completeness >= 50 ? 'text-warn' : 'text-danger',
                        )}
                        dir="ltr"
                      >
                        {location.completeness}%
                      </span>
                    </div>
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-elevated">
                      <div
                        className={cn(
                          'h-full rounded-full',
                          location.completeness >= 80 ? 'bg-ok'
                            : location.completeness >= 50 ? 'bg-warn' : 'bg-danger',
                        )}
                        style={{ width: `${location.completeness}%` }}
                      />
                    </div>
                    <p className="mt-1.5 text-[10.5px] text-muted">{t('google.completenessNote')}</p>
                  </Card>
                ))}
              </div>

              {problems.length > 0 ? (
                <Card className="mt-4 p-3.5">
                  <p className="text-[13px] font-semibold">{t('google.fixThese')}</p>
                  <ul className="mt-2 space-y-2">
                    {problems.map(({ location, finding }) => (
                      <li key={`${location.locationId}-${finding.key}`} className="flex items-start gap-2">
                        <span
                          className={cn(
                            'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
                            finding.severity === 'CRITICAL' ? 'bg-danger' : 'bg-warn',
                          )}
                        />
                        <div className="min-w-0">
                          <p className="text-[12.5px] font-medium" dir="auto">
                            {location.title} — {finding.title}
                          </p>
                          <p className="text-[11.5px] text-muted" dir="auto">{finding.detail}</p>
                          {finding.action ? (
                            <p className="text-[11.5px] text-brand" dir="auto">{finding.action}</p>
                          ) : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                </Card>
              ) : null}

              {audit.data.nap.length > 0 ? (
                <Card className="mt-4 p-3.5">
                  <p className="text-[13px] font-semibold">{t('google.napTitle')}</p>
                  <p className="mt-0.5 text-[11px] text-muted">{t('google.napNote')}</p>
                  <ul className="mt-2 space-y-2">
                    {audit.data.nap.map((finding) => (
                      <li key={finding.field}>
                        <p className="text-[12.5px] font-medium">{humanize(finding.field)}</p>
                        <p className="text-[11.5px] text-muted" dir="auto">{finding.detail}</p>
                        <p className="mt-0.5 text-[11px] text-muted" dir="auto">{finding.values.join(' · ')}</p>
                      </li>
                    ))}
                  </ul>
                </Card>
              ) : null}
            </>
          )}

          {/*
            * The honest half of Local SEO. Google publishes no API for rank
            * tracking or competitor ranks, so they are named as unavailable
            * rather than rendered as an empty chart.
            */}
          <Card className="mt-4 p-3.5">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">
              {t('google.unsupportedTitle')}
            </p>
            <ul className="mt-2 space-y-1.5">
              {audit.data.unsupported.map((entry) => (
                <li key={entry.key} className="text-[12px]">
                  <span className="font-medium">{entry.title}</span>
                  <span className="text-muted"> — {t('google.unsupportedLabel')}. {entry.reason}</span>
                </li>
              ))}
            </ul>
          </Card>
        </>
      ) : null}
    </>
  );
}

/** Resolves /app/google/:section so the group shares one route entry. */
export function GoogleSectionPage() {
  const { section } = useParams<{ section?: string }>();
  if (section === 'locations') return <GoogleLocationsPage />;
  if (section === 'reviews') return <GoogleReviewsPage />;
  if (section === 'seo') return <GoogleSeoPage />;
  return <GoogleOverviewPage />;
}
