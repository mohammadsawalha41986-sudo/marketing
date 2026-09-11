/**
 * ContentPreview — one preview, every surface.
 *
 * Image ads, video ads, organic content, social posting, the calendar and
 * campaign creatives all need to answer the same question: *what will this
 * actually look like when it goes out?* Each of those screens used to answer it
 * slightly differently, which meant the caption that fitted on the content page
 * was clipped on the posting page, and a fix to one preview never reached the
 * other five.
 *
 * So there is one component. It knows the shape of each surface, the chrome
 * around it, and where the platform's own interface will sit on top of the
 * creative. Everything else it is told.
 *
 * Two things it deliberately does not do:
 *
 *   - It never invents a state. `status` is rendered only when a caller passes
 *     one, and a caller only has one when the API returned it. A preview that
 *     shows "Published" because a component decided to is a lie about somebody's
 *     ad account.
 *   - It is not a pixel-accurate clone. It is close enough to judge fit,
 *     legibility and crop, which is the decision being made in front of it.
 */

import { useMemo, type ReactNode } from 'react';
import { ImageOff, Play } from 'lucide-react';

import { Badge } from './ui';
import { StatusBadge } from './domain';
import { cn } from '../lib/utils';
import { PLATFORM_COLORS, PLATFORM_LABELS, dateTime } from '../lib/format';
import { useI18n } from '../lib/i18n';
import type { Platform } from '../lib/api';

// ---------------------------------------------------------------- the registry

/** Where a piece of content is placed. The shape follows from this, not the platform. */
export type Surface = 'FEED' | 'STORY' | 'REEL' | 'SEARCH' | 'DISPLAY';

export interface SurfaceSpec {
  surface: Surface;
  label: string;
  /** width / height. Drives the frame, so a 9:16 story is never previewed square. */
  ratio: number;
  /**
   * Fractions of the frame the platform's own UI covers. Creative may extend
   * into them, but nothing that has to be *read* should.
   */
  safe?: { top?: number; bottom?: number; start?: number; end?: number };
}

const FEED_SQUARE: SurfaceSpec = { surface: 'FEED', label: 'Feed', ratio: 1 };
const FEED_PORTRAIT: SurfaceSpec = { surface: 'FEED', label: 'Feed', ratio: 4 / 5 };
const LANDSCAPE: SurfaceSpec = { surface: 'FEED', label: 'Feed', ratio: 1.91 };

/**
 * Vertical placements are where safe zones matter: the caption rail, the action
 * buttons and the system clock all sit on top of the creative.
 */
const STORY: SurfaceSpec = {
  surface: 'STORY',
  label: 'Story',
  ratio: 9 / 16,
  safe: { top: 0.14, bottom: 0.2 },
};

const REEL: SurfaceSpec = {
  surface: 'REEL',
  label: 'Reel',
  ratio: 9 / 16,
  safe: { top: 0.12, bottom: 0.28, end: 0.16 },
};

const TIKTOK_FEED: SurfaceSpec = {
  surface: 'FEED',
  label: 'For You',
  ratio: 9 / 16,
  safe: { top: 0.1, bottom: 0.3, end: 0.18 },
};

/** Every surface the app can preview, per platform. First entry is the default. */
export const PLATFORM_SURFACES: Record<string, SurfaceSpec[]> = {
  FACEBOOK: [FEED_SQUARE, { ...FEED_PORTRAIT, label: 'Feed (4:5)' }, STORY, REEL],
  INSTAGRAM: [FEED_PORTRAIT, { ...FEED_SQUARE, label: 'Feed (1:1)' }, STORY, REEL],
  TIKTOK: [TIKTOK_FEED],
  SNAPCHAT: [STORY],
  X: [{ surface: 'FEED', label: 'Timeline', ratio: 16 / 9 }],
  LINKEDIN: [LANDSCAPE, { ...FEED_SQUARE, label: 'Feed (1:1)' }],
  GOOGLE_BUSINESS: [{ surface: 'FEED', label: 'Post', ratio: 4 / 3 }],
  GOOGLE_ADS: [
    { surface: 'SEARCH', label: 'Search', ratio: 0 },
    { surface: 'DISPLAY', label: 'Display', ratio: 1.91 },
  ],
};

/**
 * Published caption limits. These are the platform's rules, not ours — the
 * counter is a warning, never a block, because the API is the authority on
 * whether a post is accepted.
 */
const CAPTION_LIMITS: Record<string, number> = {
  FACEBOOK: 63_206,
  INSTAGRAM: 2_200,
  TIKTOK: 2_200,
  SNAPCHAT: 250,
  X: 280,
  LINKEDIN: 3_000,
  GOOGLE_BUSINESS: 1_500,
  GOOGLE_ADS: 90,
};

export function surfacesFor(platform: Platform | string): SurfaceSpec[] {
  return PLATFORM_SURFACES[platform] ?? [FEED_SQUARE];
}

// ---------------------------------------------------------------- media frame

export interface PreviewMedia {
  url: string;
  kind?: 'IMAGE' | 'VIDEO';
  /** Shown while a video loads, and used as the still in dense listings. */
  posterUrl?: string | null;
  alt?: string;
}

function MediaFrame({
  media, spec, color, safeZones, compact, overlay,
}: {
  media?: PreviewMedia | null;
  spec: SurfaceSpec;
  color: string;
  safeZones: boolean;
  compact: boolean;
  overlay?: ReactNode;
}) {
  const isVideo = media?.kind === 'VIDEO';

  return (
    <div
      className="relative w-full overflow-hidden"
      style={{
        aspectRatio: String(spec.ratio),
        background: `linear-gradient(135deg, ${color}22, ${color}08)`,
      }}
    >
      {media?.url ? (
        isVideo ? (
          // muted + playsInline so a preview never surprises anyone with sound,
          // and never blocks autoplay policy on mobile.
          <video
            src={media.url}
            poster={media.posterUrl ?? undefined}
            controls={!compact}
            muted
            playsInline
            preload="metadata"
            className="h-full w-full object-cover"
          />
        ) : (
          <img src={media.url} alt={media.alt ?? ''} className="h-full w-full object-cover" />
        )
      ) : (
        <div className="grid h-full w-full place-items-center px-6 text-center">
          <span className="text-muted">
            <ImageOff className="mx-auto mb-1.5 h-5 w-5" />
            <span className="block text-[12px]">Attach media to preview the creative</span>
          </span>
        </div>
      )}

      {isVideo && compact ? (
        <span className="pointer-events-none absolute inset-0 grid place-items-center">
          <span className="grid h-10 w-10 place-items-center rounded-full bg-black/45 text-white backdrop-blur-sm">
            <Play className="h-4 w-4 translate-x-[1px] fill-current" />
          </span>
        </span>
      ) : null}

      {/*
       * Safe zones. Drawn over the creative rather than beside it, because the
       * only useful version of this information is "your text is under the
       * caption rail" — which you cannot see in a diagram.
       */}
      {safeZones && spec.safe ? (
        <div className="pointer-events-none absolute inset-0">
          {(['top', 'bottom', 'start', 'end'] as const).map((edge) => {
            const size = spec.safe?.[edge];
            if (!size) return null;
            const axis = edge === 'top' || edge === 'bottom' ? 'height' : 'width';
            return (
              <span
                key={edge}
                className={cn(
                  'absolute bg-danger/20',
                  edge === 'top' && 'inset-x-0 top-0 border-b',
                  edge === 'bottom' && 'inset-x-0 bottom-0 border-t',
                  edge === 'start' && 'inset-y-0 start-0 border-e',
                  edge === 'end' && 'inset-y-0 end-0 border-s',
                  'border-dashed border-danger/60',
                )}
                style={{ [axis]: `${size * 100}%` }}
              />
            );
          })}
          <span className="absolute bottom-1 start-1 rounded bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-white">
            Platform UI
          </span>
        </div>
      ) : null}

      {overlay}
    </div>
  );
}

// ---------------------------------------------------------------- the component

export interface ContentPreviewProps {
  platform: Platform | string;
  /** Defaults to the platform's primary surface. */
  surface?: Surface;
  brandName: string;
  logoUrl?: string | null;
  headline?: string | null;
  caption?: string | null;
  cta?: string | null;
  hashtags?: string[];
  media?: PreviewMedia | null;
  /** Convenience for the many callers that only have an image URL. */
  mediaUrl?: string | null;
  /** Only ever a status the server reported. Omit it and nothing is claimed. */
  status?: string | null;
  scheduledAt?: string | Date | null;
  /** Overlay the platform's own chrome position on the creative. */
  safeZones?: boolean;
  /** Card-sized: drops the caption body and video controls, for grids and calendars. */
  compact?: boolean;
  className?: string;
}

export function ContentPreview({
  platform, surface, brandName, logoUrl, headline, caption, cta, hashtags,
  media, mediaUrl, status, scheduledAt, safeZones = false, compact = false, className,
}: ContentPreviewProps) {
  const { lang } = useI18n();
  const color = PLATFORM_COLORS[platform] ?? '#94a3b8';

  const spec = useMemo(() => {
    const available = surfacesFor(platform);
    return available.find((entry) => entry.surface === surface) ?? available[0];
  }, [platform, surface]);

  const resolved: PreviewMedia | null = media ?? (mediaUrl ? { url: mediaUrl, kind: 'IMAGE' } : null);
  const tags = (hashtags ?? []).filter(Boolean).slice(0, 8).join(' ');
  const limit = CAPTION_LIMITS[platform];
  const over = Boolean(limit && caption && caption.length > limit);

  /*
   * The header strip carries the only facts the preview is allowed to assert
   * about state: the platform, the surface, and whatever status the caller was
   * given. It sits outside the mock chrome so it can never be mistaken for part
   * of the post itself.
   */
  const meta = (
    <div className="flex flex-wrap items-center gap-1.5 px-3.5 pt-3">
      <Badge tone="neutral">{PLATFORM_LABELS[platform] ?? platform}</Badge>
      <Badge tone="neutral">{spec.label}</Badge>
      {status ? <StatusBadge status={status} kind="content" /> : null}
      {scheduledAt ? (
        <span className="text-[11px] text-muted">{dateTime(scheduledAt, lang)}</span>
      ) : null}
    </div>
  );

  // Search has no creative at all — it is text in a results page, and previewing
  // it as a feed post would be preview theatre.
  if (spec.surface === 'SEARCH') {
    return (
      <div className={cn('overflow-hidden rounded-xl border border-line bg-surface', className)}>
        {meta}
        <div className="p-3.5">
          <div className="mb-1 flex items-center gap-2 text-[11px] text-muted">
            <span className="rounded border border-line px-1 font-semibold">Ad</span>
            <span className="truncate">{brandName.toLowerCase().replace(/\s+/g, '')}.com</span>
          </div>
          <p className="text-[17px] leading-snug text-[#1a0dab] dark:text-[#8ab4f8]">
            {headline || 'Your headline appears here'}
          </p>
          <p className="mt-1 text-[13px] leading-relaxed text-muted">
            {caption || 'Your description text appears here, up to about 90 characters.'}
          </p>
        </div>
      </div>
    );
  }

  const vertical = spec.ratio > 0 && spec.ratio < 1;

  return (
    <div className={cn('overflow-hidden rounded-xl border border-line bg-surface', className)}>
      {meta}

      <div className="mt-2.5 flex items-center gap-2.5 px-3.5 pb-2.5">
        {logoUrl ? (
          <img src={logoUrl} alt="" className="h-8 w-8 rounded-full object-cover ring-1 ring-line" />
        ) : (
          <span className="h-8 w-8 rounded-full" style={{ background: `linear-gradient(135deg, ${color}, ${color}66)` }} />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold text-fg">{brandName}</p>
          <p className="text-[11px] text-muted">Sponsored</p>
        </div>
        <span className="text-lg leading-none text-muted">···</span>
      </div>

      <MediaFrame
        media={resolved}
        spec={spec}
        color={color}
        safeZones={safeZones}
        compact={compact}
        overlay={
          // On a vertical surface the caption is burned over the creative, so
          // previewing it underneath would answer the wrong question.
          vertical && headline ? (
            /* Clamped: a headline burned over the creative has only the room
               the surface gives it, and an unclamped one runs past the frame
               and is cut mid-word by the frame's own clipping. */
            <span className="pointer-events-none absolute bottom-[6%] start-3 line-clamp-2 max-w-[70%] text-[13px] font-medium text-white drop-shadow-[0_1px_3px_rgba(0,0,0,0.8)]">
              {headline}
            </span>
          ) : null
        }
      />

      {cta ? (
        <div className="flex items-center justify-between border-y border-line px-3.5 py-2.5">
          <span className="truncate text-[13px] text-muted">{brandName}</span>
          <span
            className="shrink-0 rounded-md px-2.5 py-1 text-[12px] font-semibold text-white"
            style={{ background: color }}
          >
            {cta}
          </span>
        </div>
      ) : null}

      {compact ? null : (
        <div className="px-3.5 py-3">
          {headline && !vertical ? <p className="text-[13px] font-semibold text-fg">{headline}</p> : null}
          {caption ? (
            <p className="mt-1 whitespace-pre-line text-[13px] leading-relaxed text-fg/90">{caption}</p>
          ) : null}
          {tags ? <p className="mt-1.5 break-words text-[13px] text-brand">{tags}</p> : null}

          {limit && caption ? (
            <p className={cn('tabular mt-2 text-[11px]', over ? 'font-medium text-danger' : 'text-muted')}>
              {caption.length} / {limit}
              {over ? ` · over the ${PLATFORM_LABELS[platform] ?? platform} limit` : null}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
