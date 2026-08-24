import { useMemo, useState } from 'react';
import { BarChart3, Eye, Heart, MessageCircle, MousePointerClick, Share2 } from 'lucide-react';

import { qs, type Platform } from '../lib/api';
import { useQuery } from '../lib/hooks';
import { useRestaurant } from '../lib/restaurant';
import { num } from '../lib/format';
import {
  Card, CardHeader, CardSkeleton, EmptyState, ErrorState, PageHeader, Select,
  TableWrap, Td, Th,
} from '../components/ui';
import { KpiCard, PlatformChip } from '../components/domain';

interface OrganicMetric {
  value: number | null;
  state: 'ZERO' | 'UNAVAILABLE' | 'NOT_FETCHED' | 'PROVIDER_ERROR';
}

interface PostMetrics {
  likes: OrganicMetric;
  comments: OrganicMetric;
  shares: OrganicMetric;
  saves: OrganicMetric;
  reach: OrganicMetric;
  impressions: OrganicMetric;
  engagements: OrganicMetric;
  clicks: OrganicMetric;
}

interface TopPost {
  platformPostId: string;
  platform: Platform;
  platformLabel: string;
  postGroupId: string;
  caption: string | null;
  status: string;
  publishedAt: string | null;
  metrics: PostMetrics;
}

interface PlatformSummary {
  platform: Platform;
  label: string;
  publishedCount: number;
  totalEngagements: number;
  totalReach: number;
  totalImpressions: number;
}

interface SocialOverview {
  totalPosts: number;
  publishedPosts: number;
  platforms: PlatformSummary[];
  topPosts: TopPost[];
  periodTotals: {
    likes: number;
    comments: number;
    shares: number;
    saves: number;
    reach: number;
    impressions: number;
    engagements: number;
    clicks: number;
  };
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function metricCell(m: OrganicMetric): string {
  if (m.state === 'UNAVAILABLE') return '—';
  if (m.state === 'NOT_FETCHED') return '…';
  if (m.state === 'PROVIDER_ERROR') return '!';
  return num(m.value ?? 0, 'en');
}

export function SocialAnalyticsPage() {
  const { currentId: clientId } = useRestaurant();
  const [days, setDays] = useState(30);

  const range = useMemo(() => {
    const to = new Date();
    const from = new Date(to.getTime() - (days - 1) * 86400000);
    return { from: isoDate(from), to: isoDate(to) };
  }, [days]);

  const { data, loading, error } = useQuery<SocialOverview>(
    `/social/analytics/overview${qs({ clientId, from: range.from, to: range.to })}`,
    [clientId, range.from, range.to],
  );

  if (error) return <ErrorState message="Failed to load social analytics." />;

  return (
    <>
      <PageHeader
        title="Social Analytics"
        subtitle="Organic post performance across platforms"
        action={
          <Select value={days} onChange={(e) => setDays(Number(e.target.value))} className="w-40">
            {[7, 14, 30, 90].map((v) => <option key={v} value={v}>Last {v} days</option>)}
          </Select>
        }
      />

      {loading || !data ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => <CardSkeleton key={i} />)}
        </div>
      ) : (
        <div className="space-y-6">
          {/* KPIs */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard label="Total Posts" value={data.totalPosts} icon={BarChart3} />
            <KpiCard label="Published" value={data.publishedPosts} icon={BarChart3} accent="brand" />
            <KpiCard label="Total Reach" value={data.periodTotals.reach} icon={Eye} />
            <KpiCard label="Total Impressions" value={data.periodTotals.impressions} icon={Eye} />
            <KpiCard label="Likes" value={data.periodTotals.likes} icon={Heart} />
            <KpiCard label="Comments" value={data.periodTotals.comments} icon={MessageCircle} />
            <KpiCard label="Shares" value={data.periodTotals.shares} icon={Share2} />
            <KpiCard label="Engagements" value={data.periodTotals.engagements} icon={MousePointerClick} accent="brand" />
          </div>

          {/* Platform breakdown */}
          {data.platforms.length > 0 && (
            <Card>
              <CardHeader title="By Platform" />
              <TableWrap>
                <table className="w-full text-sm">
                  <thead>
                    <tr>
                      <Th>Platform</Th>
                      <Th align="end">Published</Th>
                      <Th align="end">Engagements</Th>
                      <Th align="end">Reach</Th>
                      <Th align="end">Impressions</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.platforms.map((p) => (
                      <tr key={p.platform}>
                        <Td><PlatformChip platform={p.platform} size="sm" /></Td>
                        <Td align="end">{num(p.publishedCount, 'en')}</Td>
                        <Td align="end">{num(p.totalEngagements, 'en')}</Td>
                        <Td align="end">{num(p.totalReach, 'en')}</Td>
                        <Td align="end">{num(p.totalImpressions, 'en')}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            </Card>
          )}

          {/* Top posts */}
          {data.topPosts.length > 0 && (
            <Card>
              <CardHeader title="Top Posts by Engagement" />
              <TableWrap>
                <table className="w-full text-sm">
                  <thead>
                    <tr>
                      <Th>Platform</Th>
                      <Th>Caption</Th>
                      <Th align="end">Likes</Th>
                      <Th align="end">Comments</Th>
                      <Th align="end">Shares</Th>
                      <Th align="end">Reach</Th>
                      <Th align="end">Engagements</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.topPosts.map((post) => (
                      <tr key={post.platformPostId}>
                        <Td><PlatformChip platform={post.platform} size="sm" /></Td>
                        <Td>
                          <span className="line-clamp-2 max-w-xs">
                            {post.caption?.slice(0, 80) || '—'}
                          </span>
                        </Td>
                        <Td align="end">{metricCell(post.metrics.likes)}</Td>
                        <Td align="end">{metricCell(post.metrics.comments)}</Td>
                        <Td align="end">{metricCell(post.metrics.shares)}</Td>
                        <Td align="end">{metricCell(post.metrics.reach)}</Td>
                        <Td align="end">{metricCell(post.metrics.engagements)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            </Card>
          )}

          {data.totalPosts === 0 && (
            <EmptyState
              icon={BarChart3}
              title="No posts yet"
              body="Create and publish social posts to see analytics here."
            />
          )}
        </div>
      )}
    </>
  );
}
