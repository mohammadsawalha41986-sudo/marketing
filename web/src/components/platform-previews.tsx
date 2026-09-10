/**
 * What the post will actually look like, one component per platform.
 *
 * Not one generic preview with a colour swapped. The reason is the product's
 * whole argument: an agency selects three platforms and gets three different
 * posts, and a preview that renders them identically quietly tells the operator
 * the opposite. The chrome is what makes the difference legible — Instagram's
 * square crop and hashtag block, TikTok's full-bleed vertical with the caption
 * over the video, LinkedIn's company byline, Google Business's CTA button.
 *
 * These are UI mock-ups. They imitate the destination closely enough to catch a
 * caption that runs long or an image cropped badly, and they are never presented
 * as coming from the platform.
 */

import type { ReactNode } from 'react';
import {
  Bookmark, Ellipsis, Globe, Heart, ImageOff, MessageCircle, MoreHorizontal, Music,
  Repeat2, Send, Share2, ThumbsUp,
} from 'lucide-react';

import { cn } from '../lib/utils';

export interface PreviewInput {
  brandName: string;
  logoUrl?: string | null;
  username?: string | null;
  headline?: string | null;
  caption?: string | null;
  hashtags?: string[];
  ctaLabel?: string | null;
  linkUrl?: string | null;
  /** Ordered media. The first is the hero; the rest matter only to carousels. */
  media?: Array<{ url: string; kind: 'IMAGE' | 'VIDEO'; alt?: string | null }>;
  /** Provider-specific settings — Instagram's mediaType, Google's postType. */
  config?: Record<string, unknown>;
}

/* ------------------------------------------------------------------ shared */

function Avatar({ logoUrl, name, size = 32 }: { logoUrl?: string | null; name: string; size?: number }) {
  return logoUrl ? (
    <img
      src={logoUrl}
      alt=""
      className="shrink-0 rounded-full object-cover"
      style={{ width: size, height: size }}
    />
  ) : (
    <span
      className="grid shrink-0 place-items-center rounded-full bg-brand/15 text-[11px] font-semibold text-brand"
      style={{ width: size, height: size }}
    >
      {name.slice(0, 2).toUpperCase()}
    </span>
  );
}

/** The media well. Ratio is the platform's, not the file's. */
function Frame({
  media, ratio, rounded = false, children,
}: {
  media?: PreviewInput['media'];
  ratio: number;
  rounded?: boolean;
  children?: ReactNode;
}) {
  const first = media?.[0];

  return (
    <div
      className={cn('relative w-full overflow-hidden bg-elevated', rounded && 'rounded-lg')}
      style={{ aspectRatio: String(ratio) }}
    >
      {first ? (
        first.kind === 'VIDEO' ? (
          <video src={first.url} muted playsInline preload="metadata" className="h-full w-full object-cover" />
        ) : (
          <img src={first.url} alt={first.alt ?? ''} className="h-full w-full object-cover" />
        )
      ) : (
        <span className="grid h-full w-full place-items-center text-muted">
          <span className="text-center">
            <ImageOff className="mx-auto mb-1 h-5 w-5" />
            <span className="block text-[11px]">No media attached</span>
          </span>
        </span>
      )}
      {children}
    </div>
  );
}

/** Caption plus hashtags, which every platform renders as one block of text. */
/**
 * Caption and hashtags.
 *
 * `clamp` is for the overlay variants — Reels and TikTok draw the caption *over*
 * the video, where the room is whatever the gradient covers. Unclamped, a long
 * caption runs past the frame and is cut mid-word by the frame's own clipping,
 * which looks like a broken preview rather than a long caption.
 */
function Body({ caption, hashtags, className, clamp }: {
  caption?: string | null; hashtags?: string[]; className?: string; clamp?: boolean;
}) {
  if (!caption && (!hashtags || hashtags.length === 0)) return null;
  return (
    <div className={cn('space-y-1', className)}>
      {caption ? (
        <p className={cn('whitespace-pre-wrap break-words', clamp && 'line-clamp-3')}>{caption}</p>
      ) : null}
      {hashtags && hashtags.length > 0 ? (
        <p className={cn('break-words text-brand', clamp && 'line-clamp-1')}>
          {hashtags.map((tag) => `#${tag}`).join(' ')}
        </p>
      ) : null}
    </div>
  );
}

/** The outer card every preview sits in, so they read as one system. */
function Shell({ children, width = 'max-w-[380px]' }: { children: ReactNode; width?: string }) {
  return (
    <div className={cn('mx-auto w-full overflow-hidden rounded-xl border border-line bg-surface', width)}>
      {children}
    </div>
  );
}

/* ---------------------------------------------------------------- Facebook */

export function FacebookPreview({ input }: { input: PreviewInput }) {
  return (
    <Shell>
      <div className="flex items-center gap-2.5 p-3">
        <Avatar logoUrl={input.logoUrl} name={input.brandName} size={36} />
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold text-fg">{input.brandName}</p>
          <p className="flex items-center gap-1 text-[11px] text-muted">
            Just now · <Globe className="h-3 w-3" />
          </p>
        </div>
        <MoreHorizontal className="ms-auto h-4 w-4 shrink-0 text-muted" />
      </div>

      <Body caption={input.caption} hashtags={input.hashtags} className="px-3 pb-2.5 text-[13px] text-fg" />

      {/* Facebook's feed image is landscape-ish; a 4:5 upload gets letterboxed. */}
      <Frame media={input.media} ratio={1.91} />

      {input.linkUrl ? (
        <div className="flex items-center gap-3 border-y border-line bg-elevated px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[10px] uppercase tracking-wide text-muted">
              {safeHost(input.linkUrl)}
            </p>
            {input.headline ? (
              <p className="truncate text-[12px] font-semibold text-fg">{input.headline}</p>
            ) : null}
          </div>
          {input.ctaLabel ? (
            <span className="shrink-0 rounded-md bg-elevated px-2.5 py-1 text-[11px] font-medium text-fg ring-1 ring-line">
              {input.ctaLabel}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="flex items-center justify-around px-3 py-2 text-[12px] text-muted">
        <span className="flex items-center gap-1.5"><ThumbsUp className="h-4 w-4" />Like</span>
        <span className="flex items-center gap-1.5"><MessageCircle className="h-4 w-4" />Comment</span>
        <span className="flex items-center gap-1.5"><Share2 className="h-4 w-4" />Share</span>
      </div>
    </Shell>
  );
}

/* --------------------------------------------------------------- Instagram */

function InstagramChrome({ input, children }: { input: PreviewInput; children: ReactNode }) {
  const handle = input.username ?? input.brandName.toLowerCase().replace(/\s+/g, '');
  return (
    <Shell>
      <div className="flex items-center gap-2.5 p-2.5">
        <Avatar logoUrl={input.logoUrl} name={input.brandName} size={30} />
        <p className="truncate text-[13px] font-semibold text-fg">{handle}</p>
        <Ellipsis className="ms-auto h-4 w-4 shrink-0 text-muted" />
      </div>
      {children}
      <div className="flex items-center gap-4 px-3 pt-2.5 text-muted">
        <Heart className="h-5 w-5" />
        <MessageCircle className="h-5 w-5" />
        <Send className="h-5 w-5" />
        <Bookmark className="ms-auto h-5 w-5" />
      </div>
      <div className="px-3 pb-3 pt-2 text-[13px] text-fg">
        <span className="me-1.5 font-semibold">{handle}</span>
        <Body caption={input.caption} hashtags={input.hashtags} className="inline" />
      </div>
    </Shell>
  );
}

export function InstagramFeedPreview({ input }: { input: PreviewInput }) {
  // 4:5 is Instagram's tallest feed crop and the one most posts are made for.
  return <InstagramChrome input={input}><Frame media={input.media} ratio={4 / 5} /></InstagramChrome>;
}

export function InstagramCarouselPreview({ input }: { input: PreviewInput }) {
  const count = Math.max(input.media?.length ?? 0, 1);
  return (
    <InstagramChrome input={input}>
      <div className="relative">
        <Frame media={input.media} ratio={1} />
        {count > 1 ? (
          <>
            <span className="absolute end-2 top-2 rounded-full bg-black/55 px-2 py-0.5 text-[11px] text-white backdrop-blur-sm">
              1/{count}
            </span>
            {/* The dots are what tell the operator a carousel is a carousel. */}
            <span className="absolute inset-x-0 bottom-2 flex justify-center gap-1">
              {Array.from({ length: Math.min(count, 10) }).map((_, index) => (
                <span
                  key={index}
                  className={cn('h-1.5 w-1.5 rounded-full', index === 0 ? 'bg-white' : 'bg-white/45')}
                />
              ))}
            </span>
          </>
        ) : null}
      </div>
    </InstagramChrome>
  );
}

export function InstagramReelPreview({ input }: { input: PreviewInput }) {
  const handle = input.username ?? input.brandName.toLowerCase().replace(/\s+/g, '');
  return (
    <Shell width="max-w-[300px]">
      <div className="relative">
        <Frame media={input.media} ratio={9 / 16} />
        {/* Reels put everything over the video, so the caption competes with it. */}
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent p-3 pt-10 text-white">
          <p className="text-[12px] font-semibold">{handle}</p>
          <Body clamp caption={input.caption} hashtags={input.hashtags} className="mt-1 text-[11px] leading-snug" />
          <p className="mt-1.5 flex items-center gap-1 text-[10px] opacity-90">
            <Music className="h-3 w-3" />Original audio
          </p>
        </div>
        <div className="absolute end-2 bottom-16 flex flex-col items-center gap-3 text-white">
          <Heart className="h-5 w-5" />
          <MessageCircle className="h-5 w-5" />
          <Send className="h-5 w-5" />
        </div>
      </div>
    </Shell>
  );
}

/* ------------------------------------------------------------------ TikTok */

export function TikTokPreview({ input }: { input: PreviewInput }) {
  const handle = input.username ?? input.brandName.toLowerCase().replace(/\s+/g, '');
  return (
    <Shell width="max-w-[300px]">
      <div className="relative bg-black">
        <Frame media={input.media} ratio={9 / 16} />
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-3 pt-12 text-white">
          <p className="text-[13px] font-semibold">@{handle}</p>
          <Body clamp caption={input.caption} hashtags={input.hashtags} className="mt-1 text-[12px] leading-snug" />
          <p className="mt-1.5 flex items-center gap-1 text-[10px] opacity-90">
            <Music className="h-3 w-3" />original sound — {handle}
          </p>
        </div>
        <div className="absolute end-2 bottom-20 flex flex-col items-center gap-4 text-white">
          <span className="grid place-items-center"><Heart className="h-6 w-6" /></span>
          <span className="grid place-items-center"><MessageCircle className="h-6 w-6" /></span>
          <span className="grid place-items-center"><Bookmark className="h-6 w-6" /></span>
          <span className="grid place-items-center"><Share2 className="h-6 w-6" /></span>
        </div>
      </div>
    </Shell>
  );
}

/* ----------------------------------------------------------------- YouTube */

export function YouTubePreview({ input }: { input: PreviewInput }) {
  const visibility = String(input.config?.visibility ?? 'PUBLIC');
  return (
    <Shell>
      <Frame media={input.media} ratio={16 / 9} />
      <div className="flex gap-2.5 p-3">
        <Avatar logoUrl={input.logoUrl} name={input.brandName} size={34} />
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-[13px] font-semibold text-fg">
            {input.headline || 'Untitled video'}
          </p>
          <p className="mt-0.5 truncate text-[11px] text-muted">{input.brandName}</p>
          <p className="text-[11px] text-muted">No views · just now</p>
        </div>
        <span className="h-fit shrink-0 rounded bg-elevated px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
          {visibility.toLowerCase()}
        </span>
      </div>
      {input.caption ? (
        <p className="line-clamp-3 whitespace-pre-wrap break-words border-t border-line px-3 py-2.5 text-[12px] text-muted">
          {input.caption}
        </p>
      ) : null}
    </Shell>
  );
}

/* ---------------------------------------------------------------- LinkedIn */

export function LinkedInPreview({ input }: { input: PreviewInput }) {
  return (
    <Shell>
      <div className="flex items-center gap-2.5 p-3">
        <Avatar logoUrl={input.logoUrl} name={input.brandName} size={40} />
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold text-fg">{input.brandName}</p>
          {/* The follower line is LinkedIn's tell — it reads as a company, not a person. */}
          <p className="truncate text-[11px] text-muted">Company · Just now</p>
        </div>
        <MoreHorizontal className="ms-auto h-4 w-4 shrink-0 text-muted" />
      </div>

      <Body caption={input.caption} hashtags={input.hashtags} className="px-3 pb-2.5 text-[13px] text-fg" />
      <Frame media={input.media} ratio={1.91} />

      <div className="flex items-center justify-around px-3 py-2 text-[12px] text-muted">
        <span className="flex items-center gap-1.5"><ThumbsUp className="h-4 w-4" />Like</span>
        <span className="flex items-center gap-1.5"><MessageCircle className="h-4 w-4" />Comment</span>
        <span className="flex items-center gap-1.5"><Repeat2 className="h-4 w-4" />Repost</span>
        <span className="flex items-center gap-1.5"><Send className="h-4 w-4" />Send</span>
      </div>
    </Shell>
  );
}

/* --------------------------------------------------------- Google Business */

export function GoogleBusinessPreview({ input }: { input: PreviewInput }) {
  const postType = String(input.config?.postType ?? 'UPDATE').toUpperCase();
  const eventStart = input.config?.eventStart ? String(input.config.eventStart) : null;
  const eventEnd = input.config?.eventEnd ? String(input.config.eventEnd) : null;

  return (
    <Shell>
      <div className="flex items-center gap-2.5 p-3">
        <Avatar logoUrl={input.logoUrl} name={input.brandName} size={32} />
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold text-fg">{input.brandName}</p>
          <p className="text-[11px] text-muted">
            {postType === 'OFFER' ? 'Offer' : postType === 'EVENT' ? 'Event' : 'Update'}
          </p>
        </div>
      </div>

      <Frame media={input.media} ratio={4 / 3} />

      <div className="space-y-1.5 p-3">
        {input.headline ? <p className="text-[13px] font-semibold text-fg">{input.headline}</p> : null}
        {/* Offers and events carry a window; an update does not. */}
        {postType !== 'UPDATE' && (eventStart || eventEnd) ? (
          <p className="text-[11px] text-muted">
            {[eventStart, eventEnd].filter(Boolean).join(' — ')}
          </p>
        ) : null}
        {input.caption ? (
          <p className="whitespace-pre-wrap break-words text-[12px] text-muted">{input.caption}</p>
        ) : null}
        {input.ctaLabel ? (
          <p className="pt-1 text-[13px] font-medium text-brand">{input.ctaLabel}</p>
        ) : null}
      </div>
    </Shell>
  );
}

/* ---------------------------------------------------------------- selector */

/** Which surfaces a platform offers, and what each is called in the tab strip. */
export const PLATFORM_VARIANTS: Record<string, Array<{ key: string; label: string }>> = {
  FACEBOOK: [{ key: 'FEED', label: 'Feed' }],
  INSTAGRAM: [
    { key: 'FEED', label: 'Feed' },
    { key: 'CAROUSEL', label: 'Carousel' },
    { key: 'REEL', label: 'Reel' },
  ],
  TIKTOK: [{ key: 'VIDEO', label: 'Video' }],
  YOUTUBE: [{ key: 'VIDEO', label: 'Video' }],
  LINKEDIN: [{ key: 'FEED', label: 'Feed' }],
  GOOGLE_BUSINESS: [
    { key: 'UPDATE', label: 'Update' },
    { key: 'OFFER', label: 'Offer' },
    { key: 'EVENT', label: 'Event' },
  ],
};

/**
 * The right preview for a platform and its chosen surface.
 *
 * A platform with no component of its own says so rather than borrowing
 * Facebook's — showing the wrong chrome is worse than showing none, because it
 * quietly asserts the post will look like something it will not.
 */
export function PlatformPreview({
  platform, variant, input,
}: { platform: string; variant?: string; input: PreviewInput }) {
  switch (platform) {
    case 'FACEBOOK':
      return <FacebookPreview input={input} />;
    case 'INSTAGRAM':
      if (variant === 'REEL') return <InstagramReelPreview input={input} />;
      if (variant === 'CAROUSEL') return <InstagramCarouselPreview input={input} />;
      return <InstagramFeedPreview input={input} />;
    case 'TIKTOK':
      return <TikTokPreview input={input} />;
    case 'YOUTUBE':
      return <YouTubePreview input={input} />;
    case 'LINKEDIN':
      return <LinkedInPreview input={input} />;
    case 'GOOGLE_BUSINESS':
      return (
        <GoogleBusinessPreview
          input={{ ...input, config: { ...input.config, postType: variant ?? input.config?.postType } }}
        />
      );
    default:
      return (
        <Shell>
          <p className="p-6 text-center text-[13px] text-muted">
            No preview for {platform.replace(/_/g, ' ').toLowerCase()} yet.
          </p>
        </Shell>
      );
  }
}

/** The host, or nothing. A malformed URL is not worth throwing over. */
function safeHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url.slice(0, 40);
  }
}
