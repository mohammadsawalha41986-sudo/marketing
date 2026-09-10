/**
 * One marketing calendar — organic content and paid campaigns on the same grid.
 *
 * This is the component §27 and §28 ask for: the unified view and every
 * platform workspace's Calendar tab are the same code with a different platform
 * filter, so there is no second implementation to keep in step.
 *
 * The hard part is that organic and paid are not the same kind of thing, and
 * flattening them would be the easy mistake. An organic post is a *moment* — it
 * goes out at 8pm on Tuesday. A paid campaign is a *flight* — it occupies every
 * day it spends money on. So a post is drawn once, on its day, and a campaign is
 * drawn on each day of its run with the span stated. Every item carries an
 * ORGANIC or PAID label, always, because the two carry different consequences
 * and an unlabelled row invites the wrong one.
 *
 * Neither endpoint is new: `/social/calendar` and `/advertising/calendar` are
 * the ones the two existing calendars already read. The channel filter decides
 * which are called, so filtering to ORGANIC does not fetch paid data and throw
 * it away.
 *
 * Platform filtering happens here rather than in the query because both
 * endpoints take a single platform, and a Meta workspace covers two. One
 * bounded request per channel and a filter over the result is fewer round trips
 * than one request per platform — §45.
 */

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';

import { qs, type Platform } from '../lib/api';
import { useQuery } from '../lib/hooks';
import { useI18n } from '../lib/i18n';
import { PLATFORM_LABELS } from '../lib/format';
import { cn } from '../lib/utils';
import { Badge, Card, CardSkeleton, EmptyState, ErrorState } from './ui';
import { PlatformChip } from './domain';

export type Channel = 'ALL' | 'ORGANIC' | 'PAID';
type View = 'week' | 'month';

interface OrganicRow {
  id: string;
  platform: Platform;
  status: string;
  scheduledAt: string | null;
  caption: string | null;
  headline: string | null;
  postGroup: {
    id: string;
    name: string;
    client: { id: string; businessName: string };
    campaign: { id: string; name: string } | null;
  };
}

interface PaidRow {
  id: string;
  name: string;
  platform: Platform;
  clientName: string;
  status: string;
  statusDetail: string;
  startDate: string;
  endDate: string;
  /** ISO days this flight covers inside the window. Computed by the server. */
  days: string[];
}

/** One thing drawn on one day. Channel is part of its identity, never inferred. */
interface Entry {
  key: string;
  channel: 'ORGANIC' | 'PAID';
  platform: Platform;
  title: string;
  detail: string | null;
  href: string;
  /** Set for a flight, so the card can say how long it runs. */
  span: { from: string; to: string } | null;
}

const isoDay = (date: Date): string => {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
};

/**
 * The window a view covers.
 *
 * The month view starts on the Sunday before the first of the month and runs to
 * the Saturday after the last, so the grid is whole weeks and a post on the
 * 31st that belongs to next month's first row is still fetched.
 */
function windowFor(view: View, anchor: Date): { from: Date; to: Date; days: Date[] } {
  if (view === 'week') {
    const from = new Date(anchor);
    from.setDate(from.getDate() - from.getDay());
    from.setHours(0, 0, 0, 0);
    const days = Array.from({ length: 7 }, (_, index) => {
      const day = new Date(from);
      day.setDate(from.getDate() + index);
      return day;
    });
    const to = new Date(days[6]!);
    to.setHours(23, 59, 59, 999);
    return { from, to, days };
  }

  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const from = new Date(first);
  from.setDate(first.getDate() - first.getDay());
  from.setHours(0, 0, 0, 0);

  const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
  const trailing = 6 - last.getDay();
  const to = new Date(last);
  to.setDate(last.getDate() + trailing);
  to.setHours(23, 59, 59, 999);

  const days: Date[] = [];
  for (let cursor = new Date(from); cursor <= to; cursor.setDate(cursor.getDate() + 1)) {
    days.push(new Date(cursor));
  }
  return { from, to, days };
}

function ChannelBadge({ channel }: { channel: 'ORGANIC' | 'PAID' }) {
  const { t } = useI18n();
  return (
    <Badge
      tone={channel === 'PAID' ? 'warn' : 'brand'}
      className="px-1 py-0 text-[9px] font-bold tracking-wide"
    >
      {t(channel === 'PAID' ? 'cal.badge.paid' : 'cal.badge.organic')}
    </Badge>
  );
}

function EntryCard({ entry }: { entry: Entry }) {
  const { t } = useI18n();
  return (
    <Link
      to={entry.href}
      className={cn(
        'block rounded-lg border p-1.5 text-start transition-colors hover:border-brand/50',
        entry.channel === 'PAID'
          ? 'border-warn/30 bg-warn/[0.06]'
          : 'border-line bg-elevated/60',
      )}
    >
      <div className="flex flex-wrap items-center gap-1">
        <ChannelBadge channel={entry.channel} />
        <PlatformChip platform={entry.platform} size="sm" />
      </div>
      {/* dir="auto" because a caption may be Arabic inside an English page. */}
      <p className="mt-1 line-clamp-2 text-[11px] font-medium leading-snug text-fg" dir="auto">
        {entry.title}
      </p>
      {entry.span ? (
        <p className="mt-0.5 text-[10px] text-muted" dir="auto">
          {t('cal.flight').replace('{from}', entry.span.from).replace('{to}', entry.span.to)}
        </p>
      ) : entry.detail ? (
        <p className="mt-0.5 truncate text-[10px] text-muted" dir="auto">{entry.detail}</p>
      ) : null}
    </Link>
  );
}

export interface MarketingCalendarProps {
  /** Restrict to a workspace's platforms. Omitted means every platform. */
  platforms?: Platform[];
  clientId?: string;
  /** Where an organic post links to; the workspace overrides it for its own tab. */
  organicBase?: string;
  paidBase?: string;
  initialView?: View;
  className?: string;
}

export function MarketingCalendar({
  platforms, clientId, organicBase = '/app/library', paidBase = '/app/marketing/advertising/campaigns',
  initialView = 'month', className,
}: MarketingCalendarProps) {
  const { t, lang } = useI18n();
  const [channel, setChannel] = useState<Channel>('ALL');
  const [view, setView] = useState<View>(initialView);
  const [anchor, setAnchor] = useState(() => new Date());

  const { from, to, days } = useMemo(() => windowFor(view, anchor), [view, anchor]);
  const fromIso = from.toISOString();
  const toIso = to.toISOString();

  /*
   * `null` skips the request entirely. Filtering to one channel should not
   * fetch the other and discard it.
   */
  const organic = useQuery<{ items: OrganicRow[] }>(
    channel === 'PAID' ? null : `/social/calendar${qs({ from: fromIso, to: toIso, clientId })}`,
    [fromIso, toIso, clientId, channel === 'PAID'],
  );
  const paid = useQuery<{ items: PaidRow[] }>(
    channel === 'ORGANIC' ? null : `/advertising/calendar${qs({ from: fromIso, to: toIso, clientId })}`,
    [fromIso, toIso, clientId, channel === 'ORGANIC'],
  );

  const allowed = useMemo(
    () => (platforms && platforms.length > 0 ? new Set(platforms) : null),
    [platforms],
  );

  /** Entries indexed by ISO day, which is how the grid reads them. */
  const byDay = useMemo(() => {
    const map = new Map<string, Entry[]>();
    const add = (day: string, entry: Entry) => {
      const list = map.get(day);
      if (list) list.push(entry);
      else map.set(day, [entry]);
    };

    for (const row of organic.data?.items ?? []) {
      if (!row.scheduledAt) continue;
      if (allowed && !allowed.has(row.platform)) continue;
      add(isoDay(new Date(row.scheduledAt)), {
        key: `o-${row.id}`,
        channel: 'ORGANIC',
        platform: row.platform,
        title: row.headline || row.caption || row.postGroup.name,
        detail: row.postGroup.campaign?.name ?? row.postGroup.client.businessName,
        href: `${organicBase}?post=${row.id}`,
        span: null,
      });
    }

    for (const row of paid.data?.items ?? []) {
      if (allowed && !allowed.has(row.platform)) continue;
      const span = {
        from: row.startDate.slice(0, 10),
        to: row.endDate.slice(0, 10),
      };
      // Drawn on every day of the flight: a campaign is not a moment.
      for (const day of row.days) {
        add(day, {
          key: `p-${row.id}-${day}`,
          channel: 'PAID',
          platform: row.platform,
          title: row.name,
          detail: row.statusDetail || row.clientName,
          href: `${paidBase}/${row.id}`,
          span,
        });
      }
    }

    return map;
  }, [organic.data, paid.data, allowed, organicBase, paidBase]);

  const loading = organic.loading || paid.loading;
  const error = organic.error ?? paid.error;
  const total = useMemo(
    () => [...byDay.values()].reduce((sum, list) => sum + list.length, 0),
    [byDay],
  );

  const step = (direction: -1 | 1) => {
    const next = new Date(anchor);
    if (view === 'week') next.setDate(next.getDate() + direction * 7);
    else next.setMonth(next.getMonth() + direction);
    setAnchor(next);
  };

  const locale = lang === 'ar' ? 'ar' : 'en';
  const heading = view === 'week'
    ? `${days[0]!.toLocaleDateString(locale, { month: 'short', day: 'numeric' })} – ${days[6]!.toLocaleDateString(locale, { month: 'short', day: 'numeric' })}`
    : anchor.toLocaleDateString(locale, { month: 'long', year: 'numeric' });

  const today = isoDay(new Date());
  const currentMonth = anchor.getMonth();

  const CHANNELS: Array<{ value: Channel; label: string }> = [
    { value: 'ALL', label: t('cal.all') },
    { value: 'ORGANIC', label: t('cal.organic') },
    { value: 'PAID', label: t('cal.paid') },
  ];

  return (
    <div className={className}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-line bg-elevated p-0.5" role="group" aria-label={t('cal.title')}>
          {CHANNELS.map((option) => (
            <button
              key={option.value}
              onClick={() => setChannel(option.value)}
              aria-pressed={channel === option.value}
              className={cn(
                'rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors',
                channel === option.value ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:text-fg',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="flex rounded-lg border border-line bg-elevated p-0.5" role="group">
          {(['week', 'month'] as View[]).map((option) => (
            <button
              key={option}
              onClick={() => setView(option)}
              aria-pressed={view === option}
              className={cn(
                'rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors',
                view === option ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:text-fg',
              )}
            >
              {t(option === 'week' ? 'cal.week' : 'cal.month')}
            </button>
          ))}
        </div>

        <div className="ms-auto flex items-center gap-1">
          <button
            onClick={() => step(-1)}
            aria-label={t('cal.previous')}
            className="grid h-8 w-8 place-items-center rounded-lg border border-line bg-elevated text-muted hover:text-fg"
          >
            {/* Logical rotation so the arrows point the right way in Arabic. */}
            <ChevronLeft className="h-4 w-4 rtl:rotate-180" />
          </button>
          <button
            onClick={() => setAnchor(new Date())}
            className="rounded-lg border border-line bg-elevated px-2.5 py-1.5 text-[12px] font-medium text-muted hover:text-fg"
          >
            {t('cal.today')}
          </button>
          <button
            onClick={() => step(1)}
            aria-label={t('cal.next')}
            className="grid h-8 w-8 place-items-center rounded-lg border border-line bg-elevated text-muted hover:text-fg"
          >
            <ChevronRight className="h-4 w-4 rtl:rotate-180" />
          </button>
        </div>
      </div>

      <p className="mb-2 text-sm font-semibold text-fg">{heading}</p>

      {error ? (
        <Card><ErrorState message={error} onRetry={() => { organic.refetch(); paid.refetch(); }} /></Card>
      ) : loading ? (
        <CardSkeleton rows={6} />
      ) : total === 0 ? (
        <Card>
          <EmptyState compact icon={CalendarDays} title={t('cal.empty')} body={t('cal.emptyBody')} />
        </Card>
      ) : (
        /*
         * The grid scrolls inside its own container rather than making the page
         * scroll: at 390px seven columns cannot fit, and a body that scrolls
         * sideways takes the navigation with it.
         */
        <Card className="overflow-x-auto p-0">
          <div className="min-w-[640px]">
            <div className="grid grid-cols-7 border-b border-line">
              {days.slice(0, 7).map((day) => (
                <div key={day.toISOString()} className="px-2 py-1.5 text-center text-[11px] font-medium text-muted">
                  {day.toLocaleDateString(locale, { weekday: 'short' })}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7">
              {days.map((day) => {
                const key = isoDay(day);
                const entries = byDay.get(key) ?? [];
                const outside = view === 'month' && day.getMonth() !== currentMonth;
                return (
                  <div
                    key={key}
                    className={cn(
                      'min-h-[104px] space-y-1 border-b border-e border-line p-1.5 last:border-e-0',
                      outside && 'bg-elevated/30',
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <span
                        className={cn(
                          'text-[11px] tabular',
                          key === today ? 'font-bold text-brand' : outside ? 'text-muted/50' : 'text-muted',
                        )}
                      >
                        {day.getDate()}
                      </span>
                    </div>
                    {entries.slice(0, 3).map((entry) => (
                      <EntryCard key={entry.key} entry={entry} />
                    ))}
                    {entries.length > 3 ? (
                      <p className="px-1 text-[10px] text-muted">
                        +{entries.length - 3} {t('cal.more')}
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        </Card>
      )}

      {/* A platform filter that is doing something says so, rather than leaving
          the operator to wonder why the grid looks empty. */}
      {allowed ? (
        <p className="mt-2 text-[12px] text-muted">
          {[...allowed].map((platform) => PLATFORM_LABELS[platform] ?? platform).join(' · ')}
        </p>
      ) : null}
    </div>
  );
}
