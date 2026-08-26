/**
 * What the advertisement will look like, in the platform's own chrome.
 *
 * The whole value of this component is that it can say "I don't know". A
 * preview is a promise about what a customer will see, and an operator approves
 * a campaign on the strength of it — so a placement rendered from missing data
 * is worse than no placement at all. The server decides which of the three
 * answers applies and why; this only draws them:
 *
 *   EXACT        drawn, with no caveat
 *   ESTIMATED    drawn, with the reason it is approximate stated on it
 *   UNAVAILABLE  not drawn — the reason replaces the frame
 *
 * The chrome itself is deliberately schematic rather than a pixel copy of
 * Facebook's UI. A near-perfect imitation invites the reader to trust details
 * it cannot actually promise (exact type, exact truncation), while a clear
 * diagram of the *layout* — where the creative sits, where the headline goes,
 * where the button is — is the thing the operator is really checking.
 */

import { useEffect, useState } from 'react';
import { AlertTriangle, Globe, Info, MoreHorizontal } from 'lucide-react';

import { useI18n } from '../lib/i18n';
import { Badge, Drawer, Spinner } from './ui';
import { PlatformChip } from './domain';

export interface PreviewPlacement {
  key: string;
  label: string;
  surface: string;
  fidelity: 'EXACT' | 'ESTIMATED' | 'UNAVAILABLE';
  reason: string | null;
  findings: Array<{ level: string; message: string }>;
}

export interface AdPreviewData {
  platform: string;
  advertiser: { name: string; avatarUrl: string | null };
  creative: {
    kind: 'IMAGE' | 'VIDEO' | null;
    url: string | null;
    width: number | null;
    height: number | null;
    durationSeconds: number | null;
  };
  headline: string | null;
  primaryText: string | null;
  description: string | null;
  callToAction: string | null;
  destination: string | null;
  placements: PreviewPlacement[];
  unavailable: string | null;
}

/** Story, Reel and TikTok chrome is a full-bleed vertical frame. */
function isImmersive(key: string): boolean {
  return /STORY|REEL|TIKTOK/.test(key);
}

function isSearch(key: string): boolean {
  return key === 'GOOGLE_SEARCH';
}

/** A call to action arrives as a provider enum; make it readable, not invented. */
function ctaLabel(value: string | null): string | null {
  if (!value) return null;
  return value.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function Media({ data, className }: { data: AdPreviewData; className?: string }) {
  if (!data.creative.url) return null;
  return data.creative.kind === 'VIDEO' ? (
    <video
      src={data.creative.url}
      className={className}
      controls
      playsInline
      // Never autoplay: a preview drawer that starts making noise is hostile.
      preload="metadata"
    />
  ) : (
    <img src={data.creative.url} alt="" className={className} />
  );
}

/** Feed chrome: avatar, name, body, creative, then the headline bar. */
function FeedFrame({ data }: { data: AdPreviewData }) {
  const { t } = useI18n();
  const cta = ctaLabel(data.callToAction);

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface">
      <div className="flex items-center gap-2.5 p-3">
        <div className="h-8 w-8 shrink-0 rounded-full bg-elevated" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold text-fg" dir="auto">{data.advertiser.name}</p>
          <p className="text-[11px] text-muted">{t('adv.p.sponsored')}</p>
        </div>
        <MoreHorizontal className="h-4 w-4 shrink-0 text-muted" aria-hidden />
      </div>

      {data.primaryText ? (
        <p className="px-3 pb-2.5 text-[13px] leading-relaxed text-fg" dir="auto">{data.primaryText}</p>
      ) : null}

      <div className="bg-elevated">
        <Media data={data} className="max-h-[320px] w-full object-cover" />
      </div>

      <div className="flex items-center gap-3 border-t border-line p-3">
        <div className="min-w-0 flex-1">
          {hostOf(data.destination) ? (
            <p className="truncate text-[10px] uppercase tracking-wide text-muted" dir="ltr">
              {hostOf(data.destination)}
            </p>
          ) : null}
          {data.headline ? (
            <p className="truncate text-[13px] font-semibold text-fg" dir="auto">{data.headline}</p>
          ) : null}
        </div>
        {cta ? (
          <span className="shrink-0 rounded-md bg-elevated px-2.5 py-1 text-[11px] font-semibold text-fg">
            {cta}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** Story/Reel/TikTok chrome: full-bleed vertical, overlaid controls. */
function ImmersiveFrame({ data }: { data: AdPreviewData }) {
  const { t } = useI18n();
  const cta = ctaLabel(data.callToAction);

  return (
    <div className="relative mx-auto aspect-[9/16] w-full max-w-[260px] overflow-hidden rounded-xl border border-line bg-elevated">
      <Media data={data} className="h-full w-full object-cover" />

      {/* Chrome sits over the creative, as it does on the real surface. */}
      <div className="absolute inset-x-0 top-0 flex items-center gap-2 bg-gradient-to-b from-black/55 to-transparent p-3">
        <div className="h-6 w-6 shrink-0 rounded-full bg-white/25" aria-hidden />
        <p className="truncate text-[11px] font-semibold text-white" dir="auto">{data.advertiser.name}</p>
        <span className="shrink-0 rounded bg-white/20 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-white">
          {t('adv.p.sponsored')}
        </span>
      </div>

      <div className="absolute inset-x-0 bottom-0 space-y-2 bg-gradient-to-t from-black/70 to-transparent p-3">
        {data.primaryText ? (
          <p className="line-clamp-2 text-[11px] leading-snug text-white" dir="auto">{data.primaryText}</p>
        ) : null}
        {cta ? (
          <span className="block rounded-md bg-white/90 px-3 py-1.5 text-center text-[11px] font-semibold text-black">
            {cta}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** Google Search chrome: text only, because a search ad is text. */
function SearchFrame({ data }: { data: AdPreviewData }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="mb-1 flex items-center gap-1.5">
        <Badge tone="neutral">Ad</Badge>
        {hostOf(data.destination) ? (
          <span className="truncate text-[12px] text-muted" dir="ltr">{hostOf(data.destination)}</span>
        ) : null}
      </div>
      {data.headline ? (
        <p className="text-[15px] font-medium leading-snug text-brand" dir="auto">{data.headline}</p>
      ) : null}
      {data.primaryText ? (
        <p className="mt-1 text-[13px] leading-relaxed text-muted" dir="auto">{data.primaryText}</p>
      ) : null}
    </div>
  );
}

function Frame({ data, placement }: { data: AdPreviewData; placement: PreviewPlacement }) {
  if (isSearch(placement.key)) return <SearchFrame data={data} />;
  if (isImmersive(placement.key)) return <ImmersiveFrame data={data} />;
  return <FeedFrame data={data} />;
}

export function AdPreview({ data }: { data: AdPreviewData }) {
  const { t } = useI18n();
  const renderable = data.placements.filter((placement) => placement.fidelity !== 'UNAVAILABLE');
  const [active, setActive] = useState<string | null>(renderable[0]?.key ?? null);

  useEffect(() => {
    // Keep the selection valid when the campaign behind the drawer changes.
    if (!renderable.some((placement) => placement.key === active)) {
      setActive(renderable[0]?.key ?? null);
    }
  }, [data, active, renderable]);

  const placement = data.placements.find((entry) => entry.key === active) ?? null;

  /*
   * Nothing renderable. The reason replaces the frame rather than sitting under
   * an empty box — an empty box reads as a loading state that never resolved.
   */
  if (!placement) {
    return (
      <div className="rounded-xl border border-dashed border-line p-6 text-center">
        <AlertTriangle className="mx-auto mb-2 h-5 w-5 text-muted" aria-hidden />
        <p className="text-sm font-medium text-fg">{t('adv.p.unavailable')}</p>
        <p className="mx-auto mt-1 max-w-sm text-[13px] leading-relaxed text-muted" dir="auto">
          {data.unavailable
            ?? data.placements.find((entry) => entry.reason)?.reason
            ?? ''}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Only placements this advertisement can actually run in. */}
      {renderable.length > 1 ? (
        <div className="flex flex-wrap gap-1.5">
          {renderable.map((entry) => (
            <button
              key={entry.key}
              type="button"
              onClick={() => setActive(entry.key)}
              className={[
                'rounded-full border px-3 py-1 text-[12px] font-medium transition-colors',
                entry.key === active
                  ? 'border-brand/40 bg-brand/12 text-brand'
                  : 'border-line text-muted hover:text-fg',
              ].join(' ')}
            >
              {entry.label}
            </button>
          ))}
        </div>
      ) : null}

      <Frame data={data} placement={placement} />

      {/*
        * The disclaimer is attached to the frame, not tucked in a corner: an
        * operator who scrolls past it has approved an approximation believing
        * it was exact.
        */}
      {placement.fidelity === 'ESTIMATED' ? (
        <div className="flex items-start gap-2 rounded-lg border border-warn/25 bg-warn/10 px-3 py-2">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" aria-hidden />
          <div className="min-w-0">
            <p className="text-[12px] font-semibold text-warn">{t('adv.p.estimated')}</p>
            {placement.reason ? (
              <p className="mt-0.5 text-[12px] leading-relaxed text-muted" dir="auto">{placement.reason}</p>
            ) : null}
          </div>
        </div>
      ) : (
        <p className="flex items-center gap-1.5 text-[12px] text-muted">
          <Globe className="h-3.5 w-3.5" aria-hidden />
          {t('adv.p.exactNote')}
        </p>
      )}
    </div>
  );
}

/** The drawer the campaign table and creative library both open. */
export function AdPreviewDrawer({
  open, onClose, data, loading, title,
}: {
  open: boolean;
  onClose: () => void;
  data: AdPreviewData | null;
  loading: boolean;
  title: string;
}) {
  const { t } = useI18n();

  return (
    <Drawer open={open} onClose={onClose} title={t('adv.p.preview')}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          {data ? <PlatformChip platform={data.platform} size="sm" /> : null}
          <p className="min-w-0 flex-1 truncate text-sm font-medium text-fg" dir="auto">{title}</p>
        </div>

        {loading ? (
          <div className="flex justify-center py-10"><Spinner /></div>
        ) : data ? (
          <AdPreview data={data} />
        ) : null}
      </div>
    </Drawer>
  );
}
