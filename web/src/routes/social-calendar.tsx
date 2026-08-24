/**
 * The content calendar, over platform posts rather than groups.
 *
 * The unit here is "a thing going out at a time". A group whose Facebook version
 * publishes Monday and whose Instagram version publishes Friday is two entries,
 * because that is how the operator experiences it — two moments to plan around,
 * not one. Rendering the group as a single block would flatten exactly the
 * per-platform independence the rest of the product is built to give.
 *
 * Four views because they answer different questions: the month for "is next
 * week too empty", the week for "what am I posting", the day for "what is left
 * today", the list for "everything that failed, oldest first".
 */

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';

import { api, qs, type Platform } from '../lib/api';
import { useQuery } from '../lib/hooks';
import { useRestaurant } from '../lib/restaurant';
import { humanize } from '../lib/format';
import { cn } from '../lib/utils';
import { Card, CardSkeleton, EmptyState, ErrorState, PageHeader, Select, useToast } from '../components/ui';

type View = 'month' | 'week' | 'day' | 'list';

interface CalendarPost {
  id: string;
  platform: Platform;
  status: string;
  scheduledAt: string | null;
  caption: string | null;
  headline: string | null;
  externalUrl: string | null;
  errorMessage: string | null;
  postGroup: {
    id: string;
    name: string;
    client: { id: string; businessName: string };
    campaign: { id: string; name: string } | null;
  };
  media: Array<{ media: { url: string; thumbnailUrl: string | null; type: string } }>;
}

const STATUS_DOT: Record<string, string> = {
  DRAFT: 'bg-muted/50', IN_REVIEW: 'bg-warn', CHANGES_REQUESTED: 'bg-warn',
  APPROVED: 'bg-ok', SCHEDULED: 'bg-brand', QUEUED: 'bg-brand', PUBLISHING: 'bg-brand',
  PUBLISHED: 'bg-ok', FAILED: 'bg-danger', CANCELLED: 'bg-muted/50',
};

/** The window a view needs, as [from, to] and a label for the header. */
function windowFor(view: View, anchor: Date): { from: Date; to: Date; label: string } {
  const start = new Date(anchor);
  if (view === 'day') {
    start.setHours(0, 0, 0, 0);
    const to = new Date(start); to.setHours(23, 59, 59, 999);
    return { from: start, to, label: start.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }) };
  }
  if (view === 'week') {
    start.setDate(start.getDate() - start.getDay());
    start.setHours(0, 0, 0, 0);
    const to = new Date(start); to.setDate(to.getDate() + 6); to.setHours(23, 59, 59, 999);
    return { from: start, to, label: `Week of ${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` };
  }
  // month and list both span the anchor's month.
  const from = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const to = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0, 23, 59, 59, 999);
  return { from, to, label: from.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) };
}

export function SocialCalendarPage() {
  const { currentId: clientId } = useRestaurant();
  const { push } = useToast();
  const [view, setView] = useState<View>('month');
  const [anchor, setAnchor] = useState(() => new Date());
  const [platform, setPlatform] = useState<string>('');
  const [status, setStatus] = useState<string>('');

  const { from, to, label } = useMemo(() => windowFor(view, anchor), [view, anchor]);

  const { data, loading, error, refetch } = useQuery<{ items: CalendarPost[] }>(
    `/social/calendar${qs({
      from: from.toISOString(), to: to.toISOString(), clientId, platform, status,
    })}`,
    [from.toISOString(), to.toISOString(), clientId, platform, status],
  );

  const step = (direction: -1 | 1) => {
    const next = new Date(anchor);
    if (view === 'day') next.setDate(next.getDate() + direction);
    else if (view === 'week') next.setDate(next.getDate() + direction * 7);
    else next.setMonth(next.getMonth() + direction);
    setAnchor(next);
  };

  const reschedule = async (postId: string, when: Date) => {
    try {
      await api.post(`/social/platform-posts/${postId}/reschedule`, { scheduledAt: when.toISOString() });
      refetch();
      push({ tone: 'success', title: 'Rescheduled' });
    } catch (err) {
      // The 409 for an already-published post arrives here, verbatim.
      push({ tone: 'error', title: 'Could not reschedule', body: err instanceof Error ? err.message : undefined });
    }
  };

  const posts = data?.items ?? [];

  return (
    <>
      <PageHeader
        title="Content calendar"
        subtitle="Every platform post, on the day it goes out."
        action={
          <div className="flex items-center gap-2">
            <Select value={platform} onChange={(e) => setPlatform(e.target.value)} className="h-9 w-auto">
              <option value="">All platforms</option>
              {['FACEBOOK', 'INSTAGRAM', 'TIKTOK', 'YOUTUBE', 'LINKEDIN', 'GOOGLE_BUSINESS'].map((p) => (
                <option key={p} value={p}>{humanize(p)}</option>
              ))}
            </Select>
            <Select value={status} onChange={(e) => setStatus(e.target.value)} className="h-9 w-auto">
              <option value="">Any status</option>
              {['SCHEDULED', 'PUBLISHED', 'FAILED', 'DRAFT'].map((s) => (
                <option key={s} value={s}>{humanize(s)}</option>
              ))}
            </Select>
          </div>
        }
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1.5">
          {(['month', 'week', 'day', 'list'] as View[]).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={cn(
                'rounded-lg border px-3 py-1.5 text-[12px] capitalize transition-colors',
                view === v ? 'border-brand bg-brand/12 text-brand' : 'border-line text-muted hover:text-fg',
              )}
            >
              {v}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => step(-1)} className="grid h-8 w-8 place-items-center rounded-lg border border-line text-muted hover:text-fg">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="min-w-[10rem] text-center text-[13px] font-medium text-fg">{label}</span>
          <button type="button" onClick={() => step(1)} className="grid h-8 w-8 place-items-center rounded-lg border border-line text-muted hover:text-fg">
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      {loading ? (
        <CardSkeleton rows={6} />
      ) : error ? (
        <ErrorState message={error} />
      ) : posts.length === 0 ? (
        <EmptyState icon={CalendarDays} title="Nothing scheduled here" body="Create a post and give it a time." />
      ) : view === 'month' ? (
        <MonthGrid anchor={anchor} posts={posts} onReschedule={reschedule} />
      ) : view === 'list' ? (
        <ListView posts={posts} />
      ) : (
        <ColumnView from={from} to={to} posts={posts} />
      )}
    </>
  );
}

/** A card small enough to sit in a calendar cell, draggable to a new day. */
function PostChip({ post, draggable = false }: { post: CalendarPost; draggable?: boolean }) {
  return (
    <Link
      to={`/app/social/${post.postGroup.id}`}
      draggable={draggable}
      onDragStart={(e) => e.dataTransfer.setData('text/platform-post', post.id)}
      className="flex items-center gap-1.5 rounded-md border border-line bg-surface px-1.5 py-1 text-[11px] transition-colors hover:border-brand/40"
    >
      {post.media[0] ? (
        <img src={post.media[0].media.thumbnailUrl ?? post.media[0].media.url} alt="" className="h-4 w-4 shrink-0 rounded object-cover" />
      ) : (
        <span className={cn('h-2 w-2 shrink-0 rounded-full', STATUS_DOT[post.status] ?? 'bg-muted/50')} />
      )}
      <span className="truncate text-fg">{humanize(post.platform)}</span>
      {post.scheduledAt ? (
        <span className="ms-auto shrink-0 text-muted">
          {new Date(post.scheduledAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
        </span>
      ) : null}
    </Link>
  );
}

function MonthGrid({
  anchor, posts, onReschedule,
}: { anchor: Date; posts: CalendarPost[]; onReschedule: (id: string, when: Date) => void }) {
  const year = anchor.getFullYear();
  const month = anchor.getMonth();
  const first = new Date(year, month, 1);
  const startPad = first.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const byDay = useMemo(() => {
    const map = new Map<number, CalendarPost[]>();
    for (const post of posts) {
      if (!post.scheduledAt) continue;
      const day = new Date(post.scheduledAt).getDate();
      map.set(day, [...(map.get(day) ?? []), post]);
    }
    return map;
  }, [posts]);

  const cells: Array<number | null> = [
    ...Array.from({ length: startPad }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  return (
    <Card className="overflow-hidden">
      <div className="grid grid-cols-7 border-b border-line bg-elevated text-center text-[11px] font-medium text-muted">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => <div key={d} className="py-2">{d}</div>)}
      </div>
      <div className="grid grid-cols-7">
        {cells.map((day, index) => (
          <div
            key={index}
            onDragOver={(e) => { if (day) e.preventDefault(); }}
            onDrop={(e) => {
              const id = e.dataTransfer.getData('text/platform-post');
              if (!id || !day) return;
              // Keep the time of day, move the date — a drag reschedules the
              // day, not the minute.
              const source = posts.find((p) => p.id === id);
              const when = source?.scheduledAt ? new Date(source.scheduledAt) : new Date();
              when.setFullYear(year, month, day);
              onReschedule(id, when);
            }}
            className={cn(
              'min-h-[92px] border-b border-e border-line p-1.5',
              day === null && 'bg-elevated/40',
            )}
          >
            {day ? (
              <>
                <p className="mb-1 text-[11px] text-muted">{day}</p>
                <div className="space-y-1">
                  {(byDay.get(day) ?? []).map((post) => <PostChip key={post.id} post={post} draggable />)}
                </div>
              </>
            ) : null}
          </div>
        ))}
      </div>
    </Card>
  );
}

/** Day and week both render as one column per day. */
function ColumnView({ from, to, posts }: { from: Date; to: Date; posts: CalendarPost[] }) {
  const days: Date[] = [];
  for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) days.push(new Date(d));

  const byDate = (day: Date) =>
    posts.filter((post) => post.scheduledAt && new Date(post.scheduledAt).toDateString() === day.toDateString());

  return (
    <div className={cn('grid gap-3', days.length > 1 ? 'sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7' : '')}>
      {days.map((day) => (
        <Card key={day.toISOString()} className="p-3">
          <p className="mb-2 text-[12px] font-medium text-fg">
            {day.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })}
          </p>
          <div className="space-y-1.5">
            {byDate(day).length === 0 ? (
              <p className="text-[11px] text-muted">—</p>
            ) : byDate(day).map((post) => <PostChip key={post.id} post={post} />)}
          </div>
        </Card>
      ))}
    </div>
  );
}

function ListView({ posts }: { posts: CalendarPost[] }) {
  return (
    <Card className="divide-y divide-line/60">
      {posts.map((post) => (
        <Link key={post.id} to={`/app/social/${post.postGroup.id}`} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-elevated/50">
          {post.media[0] ? (
            <img src={post.media[0].media.thumbnailUrl ?? post.media[0].media.url} alt="" className="h-10 w-10 shrink-0 rounded object-cover" />
          ) : (
            <span className={cn('h-10 w-10 shrink-0 rounded', STATUS_DOT[post.status] ?? 'bg-muted/30')} />
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium text-fg">
              {humanize(post.platform)} · {post.postGroup.name}
            </p>
            <p className="truncate text-[12px] text-muted">
              {post.headline || post.caption || 'No text'}
            </p>
            {post.errorMessage ? <p className="truncate text-[12px] text-danger">{post.errorMessage}</p> : null}
          </div>
          <div className="shrink-0 text-end">
            <span className={cn('inline-block h-2 w-2 rounded-full', STATUS_DOT[post.status] ?? 'bg-muted/50')} />
            <p className="mt-1 text-[11px] text-muted">
              {post.scheduledAt
                ? new Date(post.scheduledAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
                : 'Unscheduled'}
            </p>
          </div>
        </Link>
      ))}
    </Card>
  );
}
