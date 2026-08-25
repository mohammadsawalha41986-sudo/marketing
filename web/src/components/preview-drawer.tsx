/**
 * The preview drawer: the post as the platform will actually render it, plus
 * the AI panel for the same post.
 *
 * Two things it deliberately does not do.
 *
 * It does not render one platform's chrome for another. The sibling switcher at
 * the top moves between the *real* platform versions of the same idea — each one
 * its own PlatformPost with its own caption and its own media — rather than
 * re-skinning the current post. Showing this post's words inside Instagram's
 * frame when the Instagram version says something different is a preview that
 * lies about what will publish.
 *
 * And it does not invent surfaces. The variant strip comes from
 * PLATFORM_VARIANTS, which lists only what each platform actually has; a
 * platform with a single surface shows no strip at all rather than a row with
 * one disabled option.
 */

import { useEffect, useMemo, useState } from 'react';
import { CalendarClock, ExternalLink, MapPin } from 'lucide-react';

import { useQuery } from '../lib/hooks';
import { useI18n, type TranslationKey } from '../lib/i18n';
import { PLATFORM_COLORS, PLATFORM_LABELS, dateTime, humanize } from '../lib/format';
import { cn } from '../lib/utils';
import { Badge, Drawer } from './ui';
import { PLATFORM_VARIANTS, PlatformPreview } from './platform-previews';
import { AiPanel } from './ai-panel';
import {
  STATUS_TONES, contentTypeOf, previewInputFor,
  type RecommendationReport, type WorkspacePost,
} from '../lib/workspace-content';

/** Dictionary lookup that degrades to the raw enum. See content-card. */
function tr(t: (key: TranslationKey) => string, key: string, fallback: string): string {
  const translated = t(key as TranslationKey);
  return translated === key ? humanize(fallback) : translated;
}

type Tab = 'preview' | 'ai';

export interface PreviewDrawerProps {
  open: boolean;
  onClose: () => void;
  /** The post being previewed. */
  post: WorkspacePost | null;
  /**
   * The other platform versions of the same idea, so the switcher can move
   * between real posts rather than re-skinning this one.
   */
  siblings?: WorkspacePost[];
  onSelectSibling?: (post: WorkspacePost) => void;
  logoUrl?: string | null;
  footer?: React.ReactNode;
}

export function PreviewDrawer({
  open, onClose, post, siblings = [], onSelectSibling, logoUrl, footer,
}: PreviewDrawerProps) {
  const { lang, t } = useI18n();
  const [tab, setTab] = useState<Tab>('preview');
  const [variant, setVariant] = useState<string | undefined>(undefined);

  // The chosen surface belongs to the post, not to the drawer: moving to the
  // Instagram version must not keep Facebook's variant selected.
  useEffect(() => {
    const configured = typeof post?.config?.mediaType === 'string' ? String(post.config.mediaType) : undefined;
    setVariant(configured);
  }, [post?.id, post?.config]);

  // Fetched only while the AI tab is open, so opening a preview does not cost a
  // recommendation request the operator never looked at.
  const shouldFetch = open && tab === 'ai' && Boolean(post);
  const ai = useQuery<RecommendationReport>(
    shouldFetch ? `/social/platform-posts/${post!.id}/recommendations` : null,
    [post?.id, shouldFetch],
  );

  const variants = useMemo(
    () => (post ? PLATFORM_VARIANTS[post.platform] ?? [] : []),
    [post],
  );

  if (!post) return null;

  const color = PLATFORM_COLORS[post.platform] ?? '#94a3b8';
  const scheduled = post.publishedAt ?? post.scheduledAt;
  // Location is only shown where it was actually set on the post. An organic
  // post with no location renders no location row rather than an empty one.
  const location = typeof post.config?.location === 'string' ? post.config.location : null;

  return (
    <Drawer open={open} onClose={onClose} title={t('library.preview')} footer={footer}>
      {/* Sibling platforms — real versions of the same idea. */}
      {siblings.length > 1 ? (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {siblings.map((sibling) => {
            const active = sibling.id === post.id;
            const siblingColor = PLATFORM_COLORS[sibling.platform] ?? '#94a3b8';
            return (
              <button
                key={sibling.id}
                type="button"
                onClick={() => onSelectSibling?.(sibling)}
                className={cn(
                  'rounded-full border px-2.5 py-1 text-[11.5px] font-medium transition-colors',
                  active ? 'text-fg' : 'border-line text-muted hover:text-fg',
                )}
                style={active ? { borderColor: `${siblingColor}66`, background: `${siblingColor}18` } : undefined}
              >
                {PLATFORM_LABELS[sibling.platform] ?? humanize(sibling.platform)}
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="mb-3 flex items-center justify-between gap-2">
        <span
          className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium"
          style={{ borderColor: `${color}44`, background: `${color}18`, color }}
        >
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
          {PLATFORM_LABELS[post.platform] ?? humanize(post.platform)} · {tr(t, `ct.${contentTypeOf(post)}`, contentTypeOf(post))}
        </span>
        <Badge tone={STATUS_TONES[post.status] ?? 'neutral'} dot>{tr(t, `st.${post.status}`, post.status)}</Badge>
      </div>

      <div className="mb-3 flex gap-1 rounded-lg bg-elevated p-0.5">
        {(['preview', 'ai'] as Tab[]).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={cn(
              'flex-1 rounded-md px-2 py-1.5 text-[12.5px] font-medium transition-colors',
              tab === value ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:text-fg',
            )}
          >
            {value === 'preview' ? t('library.preview') : t('ai.tab')}
          </button>
        ))}
      </div>

      {tab === 'preview' ? (
        <>
          {/* Only shown for platforms that genuinely have more than one surface. */}
          {variants.length > 1 ? (
            <div className="mb-3 flex flex-wrap gap-1.5">
              {variants.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  onClick={() => setVariant(option.key)}
                  className={cn(
                    'rounded-full border px-2.5 py-1 text-[11.5px] transition-colors',
                    (variant ?? variants[0].key) === option.key
                      ? 'border-brand bg-brand/12 text-brand'
                      : 'border-line text-muted hover:text-fg',
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
          ) : null}

          <PlatformPreview
            platform={post.platform}
            variant={variant ?? variants[0]?.key}
            input={previewInputFor(post, logoUrl)}
          />

          <div className="mt-3 space-y-1.5 text-[12px] text-muted">
            {scheduled ? (
              <p className="flex items-center gap-1.5">
                <CalendarClock className="h-3.5 w-3.5 shrink-0" />
                <span dir="ltr">{dateTime(scheduled, lang)}</span>
                <span>· {post.timezone}</span>
              </p>
            ) : null}

            {location ? (
              <p className="flex items-center gap-1.5">
                <MapPin className="h-3.5 w-3.5 shrink-0" />
                {location}
              </p>
            ) : null}

            {post.integrationAccount ? (
              <p className="truncate">{post.integrationAccount.name}</p>
            ) : (
              <p className="text-warn">{t('library.noAccount')}</p>
            )}

            {post.externalUrl ? (
              <a
                href={post.externalUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1.5 text-brand hover:underline"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                {t('library.openOnPlatform')}
              </a>
            ) : null}
          </div>
        </>
      ) : (
        <AiPanel
          report={ai.data}
          loading={ai.loading}
          error={ai.error}
          onRetry={ai.refetch}
        />
      )}
    </Drawer>
  );
}
