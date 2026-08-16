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
import { Clapperboard, Image as ImageIcon, Plus, Sparkles, Trash2, TriangleAlert } from 'lucide-react';

import { api, qs, type Platform } from '../lib/api';
import { useQuery } from '../lib/hooks';
import { useI18n } from '../lib/i18n';
import { useRestaurant } from '../lib/restaurant';
import { bytes } from '../lib/utils';
import { relative } from '../lib/format';
import {
  Badge, Button, Card, CardHeader, CardSkeleton, EmptyState, Field, Input, PageHeader, Select, useToast,
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

// ---------------------------------------------------------------- video ads

/**
 * Video Ads.
 *
 * FFmpeg is reported by the API as a capability, not assumed: a deployment
 * without it answers 503 and says why. This page reads that first and says so
 * plainly rather than offering a render button that cannot work.
 *
 * Every line of the script is editable, which is the whole point of showing the
 * scenes as fields instead of generating them invisibly at render time.
 */

interface Placement {
  key: string;
  platform: Platform;
  label: string;
  width: number;
  height: number;
  defaultDurationSeconds: number;
}

interface VideoRow {
  id: string;
  clientId: string;
  platform: Platform;
  placement: string;
  width: number;
  height: number;
  durationSeconds: number;
  sizeBytes: number;
  status: string;
  url: string;
  createdAt: string;
}

type SceneKind = 'HOOK' | 'PRODUCT' | 'BENEFIT' | 'OFFER' | 'CTA';
type SceneMotion = 'ZOOM_IN' | 'ZOOM_OUT' | 'PAN_LEFT' | 'PAN_RIGHT' | 'STATIC';

interface SceneDraft {
  kind: SceneKind;
  text: string;
  subtext: string;
  durationSeconds: number;
  motion: SceneMotion;
}

const SCENE_KINDS: SceneKind[] = ['HOOK', 'PRODUCT', 'BENEFIT', 'OFFER', 'CTA'];
const SCENE_MOTIONS: SceneMotion[] = ['ZOOM_IN', 'ZOOM_OUT', 'PAN_LEFT', 'PAN_RIGHT', 'STATIC'];

const STARTING_SCENES: SceneDraft[] = [
  { kind: 'HOOK', text: '', subtext: '', durationSeconds: 3, motion: 'ZOOM_IN' },
  { kind: 'PRODUCT', text: '', subtext: '', durationSeconds: 5, motion: 'PAN_LEFT' },
  { kind: 'CTA', text: '', subtext: '', durationSeconds: 4, motion: 'STATIC' },
];

export function VideoAdsPage() {
  const { t, lang } = useI18n();
  const { push } = useToast();
  const { current, currentId } = useRestaurant();

  const [placements, setPlacements] = useState<string[]>([]);
  const [sources, setSources] = useState<string[]>([]);
  const [scenes, setScenes] = useState<SceneDraft[]>(STARTING_SCENES);
  const [rendering, setRendering] = useState(false);
  const [renderedAt, setRenderedAt] = useState(0);

  const catalog = useQuery<{
    capability: { available: boolean; reason?: string | null };
    placements: Placement[];
  }>('/videos/placements');

  const library = useQuery<{ items: Array<{ id: string; url: string; originalName: string }> }>(
    currentId ? `/media${qs({ clientId: currentId, type: 'IMAGE', pageSize: 24 })}` : null,
    [currentId],
  );

  const videos = useQuery<{ videos: VideoRow[] }>('/videos', [renderedAt]);
  const mine = useMemo(
    () => (videos.data?.videos ?? []).filter((row) => !currentId || row.clientId === currentId),
    [videos.data, currentId],
  );

  const available = catalog.data?.capability.available ?? false;

  const toggle = (list: string[], value: string, max: number) =>
    list.includes(value) ? list.filter((item) => item !== value) : list.length >= max ? list : [...list, value];

  const render = async () => {
    if (sources.length === 0 || placements.length === 0) {
      push({ tone: 'error', title: 'Pick at least one image and one placement' });
      return;
    }
    const written = scenes.filter((scene) => scene.text.trim().length > 0);
    if (written.length === 0) {
      push({ tone: 'error', title: 'Write at least one line of script' });
      return;
    }

    setRendering(true);
    try {
      const result = await api.post<{ videos: VideoRow[] }>('/videos', {
        mediaIds: sources,
        placementKeys: placements,
        targetSeconds: written.reduce((total, scene) => total + scene.durationSeconds, 0),
        scenes: written.map((scene) => ({
          kind: scene.kind,
          text: scene.text.trim(),
          subtext: scene.subtext.trim() || null,
          durationSeconds: scene.durationSeconds,
          motion: scene.motion,
        })),
      });
      push({ tone: 'success', title: `Rendered ${result.videos.length} video${result.videos.length === 1 ? '' : 's'}` });
      setRenderedAt(Date.now());
    } catch (err) {
      // Includes the 503 the server sends when FFmpeg is missing, verbatim.
      push({ tone: 'error', title: 'Render failed', body: err instanceof Error ? err.message : undefined });
    } finally {
      setRendering(false);
    }
  };

  return (
    <>
      <PageHeader
        title={t('nav.videoAds')}
        subtitle={
          current
            ? `Short vertical video for ${current.businessName}, built from images already in the library.`
            : 'Choose a restaurant in the top bar — video is built from that restaurant’s own imagery.'
        }
        action={
          <Button icon={Clapperboard} onClick={render} loading={rendering} disabled={!available || !currentId}>
            Render video
          </Button>
        }
      />

      {catalog.loading ? (
        <CardSkeleton rows={2} />
      ) : !available ? (
        <Card className="mb-4 p-4">
          <p className="flex items-start gap-2 text-[13px] text-fg">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
            <span>
              Video rendering is unavailable on this deployment.{' '}
              <span className="text-muted">{catalog.data?.capability.reason ?? 'FFmpeg is not installed.'}</span>
            </span>
          </p>
        </Card>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-4">
          <Card>
            <CardHeader title="Source imagery" subtitle="Up to eight, used in the order you pick them." icon={ImageIcon} />
            <div className="p-4">
              {library.loading ? (
                <CardSkeleton rows={3} />
              ) : (library.data?.items.length ?? 0) === 0 ? (
                <p className="text-[13px] text-muted">No images for this restaurant yet — upload some in Assets.</p>
              ) : (
                <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
                  {library.data?.items.map((item) => {
                    const index = sources.indexOf(item.id);
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setSources((list) => toggle(list, item.id, 8))}
                        className={`relative overflow-hidden rounded-lg border ${index >= 0 ? 'border-brand' : 'border-line hover:border-brand/40'}`}
                      >
                        <img src={item.url} alt={item.originalName} className="aspect-square w-full object-cover" />
                        {index >= 0 ? (
                          <span className="absolute end-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-brand text-[11px] font-semibold text-white">
                            {index + 1}
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="Placements" subtitle="Up to four. Each renders at its own dimensions." icon={Clapperboard} />
            <div className="flex flex-wrap gap-2 p-4">
              {catalog.data?.placements.map((placement) => (
                <button
                  key={placement.key}
                  type="button"
                  onClick={() => setPlacements((list) => toggle(list, placement.key, 4))}
                  className={`rounded-xl border px-3 py-2 text-[13px] ${
                    placements.includes(placement.key)
                      ? 'border-brand bg-brand/10 text-brand'
                      : 'border-line text-muted hover:border-brand/40'
                  }`}
                >
                  {placement.label}
                  <span className="ms-1.5 text-[11px] text-muted">{placement.width}×{placement.height}</span>
                </button>
              ))}
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Script"
              subtitle="Every line is yours. Nothing is generated behind your back at render time."
              icon={Sparkles}
              action={
                <Button
                  variant="ghost"
                  icon={Plus}
                  onClick={() =>
                    setScenes((list) =>
                      list.length >= 8 ? list : [...list, { kind: 'BENEFIT', text: '', subtext: '', durationSeconds: 4, motion: 'STATIC' }],
                    )
                  }
                >
                  Add scene
                </Button>
              }
            />
            <div className="space-y-3 p-4">
              {scenes.map((scene, index) => (
                <div key={index} className="grid gap-2 rounded-xl border border-line p-3 sm:grid-cols-[110px_minmax(0,1fr)_90px_120px_auto]">
                  <Select
                    value={scene.kind}
                    onChange={(event) =>
                      setScenes((list) => list.map((row, i) => (i === index ? { ...row, kind: event.target.value as SceneKind } : row)))
                    }
                  >
                    {SCENE_KINDS.map((kind) => <option key={kind} value={kind}>{kind.toLowerCase()}</option>)}
                  </Select>
                  <Input
                    value={scene.text}
                    onChange={(event) =>
                      setScenes((list) => list.map((row, i) => (i === index ? { ...row, text: event.target.value } : row)))
                    }
                    placeholder={index === 0 ? 'Hungry yet?' : 'On screen text'}
                    maxLength={200}
                  />
                  <Input
                    type="number"
                    min={1}
                    max={10}
                    value={scene.durationSeconds}
                    onChange={(event) =>
                      setScenes((list) =>
                        list.map((row, i) => (i === index ? { ...row, durationSeconds: Number(event.target.value) } : row)),
                      )
                    }
                  />
                  <Select
                    value={scene.motion}
                    onChange={(event) =>
                      setScenes((list) => list.map((row, i) => (i === index ? { ...row, motion: event.target.value as SceneMotion } : row)))
                    }
                  >
                    {SCENE_MOTIONS.map((motion) => (
                      <option key={motion} value={motion}>{motion.replace('_', ' ').toLowerCase()}</option>
                    ))}
                  </Select>
                  <Button
                    variant="ghost"
                    icon={Trash2}
                    onClick={() => setScenes((list) => list.filter((_, i) => i !== index))}
                    disabled={scenes.length === 1}
                  >
                    <span className="sr-only">Remove scene</span>
                  </Button>
                </div>
              ))}
            </div>
          </Card>
        </div>

        <Card className="h-fit">
          <CardHeader title="Rendered videos" icon={Clapperboard} />
          {videos.loading ? (
            <div className="p-4"><CardSkeleton rows={3} /></div>
          ) : mine.length === 0 ? (
            <EmptyState icon={Clapperboard} title="Nothing rendered yet" body="Pick imagery, a placement and a script, then render." />
          ) : (
            <div className="space-y-3 p-3">
              {mine.slice(0, 12).map((video) => (
                <div key={video.id} className="rounded-xl border border-line p-2">
                  {/* Range requests are honoured by the API, so seeking works. */}
                  <video src={video.url} controls preload="metadata" className="w-full rounded-lg bg-black" />
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-medium text-fg">
                        {video.placement.replace(/_/g, ' ').toLowerCase()}
                      </p>
                      <p className="text-[11px] text-muted">
                        {video.width}×{video.height} · {video.durationSeconds}s · {bytes(video.sizeBytes)} ·{' '}
                        {relative(video.createdAt, lang)}
                      </p>
                    </div>
                    <a
                      className="rounded-lg border border-line px-2.5 py-1 text-[12px] font-medium hover:border-brand/40"
                      href={`/api/videos/${video.id}/download`}
                    >
                      MP4
                    </a>
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
