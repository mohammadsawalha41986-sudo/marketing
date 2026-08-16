/**
 * Image Ads — the creative bench on its own page.
 *
 * The rendering workflow already existed inside the AI Content Studio, where it
 * sat below a copywriting brief. Most of the time the job is the other way
 * round: there is a photo of a dish, and it needs to come out as artwork at
 * every platform's dimensions. So this page hosts the same CreativeStudio
 * component — not a second copy of it — with the copy fields it burns in
 * exposed directly, plus everything rendered for this restaurant so far.
 */

import { useMemo, useState } from 'react';
import { Image as ImageIcon, Sparkles } from 'lucide-react';

import { type Platform } from '../lib/api';
import { useQuery } from '../lib/hooks';
import { useI18n } from '../lib/i18n';
import { useRestaurant } from '../lib/restaurant';
import { bytes } from '../lib/utils';
import { relative } from '../lib/format';
import {
  Badge, Card, CardHeader, CardSkeleton, EmptyState, Field, Input, PageHeader, Select,
} from '../components/ui';
import { PlatformChip } from '../components/domain';
import { CreativeStudio } from '../components/creative-studio';

/** The platforms the preset catalogue can render for. */
const PLATFORMS: Platform[] = ['INSTAGRAM', 'FACEBOOK', 'TIKTOK', 'SNAPCHAT', 'X', 'LINKEDIN'];

interface CreativeRow {
  id: string;
  clientId: string;
  platform: Platform;
  preset: string;
  width: number;
  height: number;
  url: string;
  sizeBytes: number;
  status: string;
  headline: string | null;
  createdAt: string;
}

export function ImageAdsPage() {
  const { t, lang } = useI18n();
  const { current, currentId } = useRestaurant();

  const [platform, setPlatform] = useState<Platform>('INSTAGRAM');
  const [headline, setHeadline] = useState('');
  const [ctaLabel, setCtaLabel] = useState('');
  // Rendering adds rows, so the gallery needs to be able to ask again.
  const [renderedAt, setRenderedAt] = useState(0);

  const { data, loading } = useQuery<{ creatives: CreativeRow[] }>('/creatives', [renderedAt]);

  // The endpoint scopes to the organization and takes the most recent hundred;
  // narrowing to the chosen restaurant is this page's job.
  const creatives = useMemo(
    () => (data?.creatives ?? []).filter((row) => !currentId || row.clientId === currentId),
    [data, currentId],
  );

  return (
    <>
      <PageHeader
        title={t('nav.imageAds')}
        subtitle={
          current
            ? `Artwork for ${current.businessName}, rendered at each platform's own dimensions.`
            : 'Choose a restaurant in the top bar — artwork belongs to one restaurant and is never shared.'
        }
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-4">
          <Card>
            <CardHeader
              title="What goes on the creative"
              subtitle="Both are burned into the artwork. Leave them empty for an image-only ad."
              icon={Sparkles}
            />
            <div className="grid gap-4 p-5 sm:grid-cols-3">
              <Field label={t('common.platform')}>
                <Select value={platform} onChange={(event) => setPlatform(event.target.value as Platform)}>
                  {PLATFORMS.map((value) => (
                    <option key={value} value={value}>{value.charAt(0) + value.slice(1).toLowerCase()}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Headline">
                <Input
                  value={headline}
                  onChange={(event) => setHeadline(event.target.value)}
                  placeholder="Two for one, every Tuesday"
                  maxLength={300}
                />
              </Field>
              <Field label="Call to action">
                <Input
                  value={ctaLabel}
                  onChange={(event) => setCtaLabel(event.target.value)}
                  placeholder="Order now"
                  maxLength={120}
                />
              </Field>
            </div>
          </Card>

          <CreativeStudio
            clientId={currentId}
            platform={platform}
            headline={headline || null}
            ctaLabel={ctaLabel || null}
            onSourceChange={() => setRenderedAt(Date.now())}
          />
        </div>

        <Card className="h-fit">
          <CardHeader title="Rendered so far" icon={ImageIcon} />
          {loading ? (
            <div className="p-4"><CardSkeleton rows={4} /></div>
          ) : creatives.length === 0 ? (
            <EmptyState
              icon={ImageIcon}
              title="Nothing rendered yet"
              body="Attach a source image and render it — every variant appears here."
            />
          ) : (
            <div className="divide-y divide-line/60">
              {creatives.slice(0, 24).map((creative) => (
                <div key={creative.id} className="flex items-center gap-3 p-3">
                  <img
                    src={creative.url}
                    alt={creative.headline ?? creative.preset}
                    className="h-14 w-14 shrink-0 rounded-lg object-cover ring-1 ring-line"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium text-fg">
                      {creative.headline ?? creative.preset.replace(/_/g, ' ').toLowerCase()}
                    </p>
                    <p className="text-[11px] text-muted">
                      {creative.width}×{creative.height} · {bytes(creative.sizeBytes)} · {relative(creative.createdAt, lang)}
                    </p>
                    <div className="mt-1 flex items-center gap-1.5">
                      <PlatformChip platform={creative.platform} size="sm" />
                      <Badge tone={creative.status === 'APPROVED' ? 'ok' : creative.status === 'SAVED' ? 'brand' : 'neutral'}>
                        {creative.status.toLowerCase()}
                      </Badge>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
