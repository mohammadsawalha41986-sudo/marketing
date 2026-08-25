/**
 * A post, as a card.
 *
 * The card carries a lot — platform, type, caption, campaign, status, schedule,
 * account, language, quality, error — and the way it stays readable is that only
 * the things that are *true of this post* are drawn. A post with no campaign has
 * no campaign row, not an empty one; a post that has not failed has no error
 * strip. Rows that render "—" for every absent field turn a dense card into a
 * form with nothing in it.
 *
 * Every action beyond opening the post lives in a menu behind the ⋯ button, for
 * the same reason: eight buttons on a card is a toolbar, and a grid of them is
 * unreadable at any width.
 *
 * Direction is never hardcoded. Spacing uses logical properties (ms/me/ps/pe,
 * start/end) so the whole card mirrors under Arabic without a second stylesheet.
 */

import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, Archive, CalendarClock, Copy, Eye, ExternalLink, FileText,
  MoreHorizontal, Pencil, Send, Sparkles, Trash2, Video,
} from 'lucide-react';

import { PLATFORM_COLORS, PLATFORM_LABELS, dateTime, humanize, relative } from '../lib/format';
import { useI18n, type TranslationKey } from '../lib/i18n';
import { cn } from '../lib/utils';
import { Badge, Button } from './ui';
import { STATUS_TONES, contentTypeOf, type WorkspacePost } from '../lib/workspace-content';

/**
 * A dictionary lookup that degrades to the raw enum.
 *
 * Statuses and content types come from the database, so a value added to an
 * enum before its translation lands must still render as something readable
 * rather than as a missing-key string.
 */
function tr(t: (key: TranslationKey) => string, key: string, fallback: string): string {
  const translated = t(key as TranslationKey);
  return translated === key ? humanize(fallback) : translated;
}

export interface ContentCardAction {
  key: string;
  label: string;
  icon: typeof Eye;
  onSelect: () => void;
  /** Destructive actions are separated and coloured. */
  danger?: boolean;
  /** Hidden entirely rather than shown disabled when the post cannot take it. */
  hidden?: boolean;
}

/**
 * The overflow menu.
 *
 * Closes on outside click and on Escape, and the trigger keeps focus so the
 * keyboard path works: Tab to the button, Enter to open, Escape to leave.
 */
function ActionMenu({ actions }: { actions: ContentCardAction[] }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const visible = actions.filter((action) => !action.hidden);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (visible.length === 0) return null;

  return (
    <div className="relative" ref={wrap}>
      <Button
        variant="ghost"
        size="icon"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Actions"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        <MoreHorizontal className="h-4 w-4" />
      </Button>

      {open ? (
        <div
          role="menu"
          className="absolute end-0 z-30 mt-1 w-52 overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-lift"
        >
          {visible.map((action) => (
            <button
              key={action.key}
              type="button"
              role="menuitem"
              className={cn(
                'flex w-full items-center gap-2.5 px-3 py-2 text-start text-[13px] transition-colors',
                action.danger
                  ? 'text-danger hover:bg-danger/10'
                  : 'text-fg hover:bg-elevated',
              )}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
                action.onSelect();
              }}
            >
              <action.icon className="h-3.5 w-3.5 shrink-0" />
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The media well, or an honest placeholder when the post carries none. */
function Thumb({ post, tall }: { post: WorkspacePost; tall: boolean }) {
  const first = post.media[0]?.media;
  const isVideo = first?.type === 'VIDEO';
  const color = PLATFORM_COLORS[post.platform] ?? '#94a3b8';

  return (
    <div
      className={cn(
        'relative shrink-0 overflow-hidden bg-elevated',
        tall ? 'aspect-[4/3] w-full' : 'h-20 w-20 rounded-lg',
      )}
    >
      {first ? (
        <img
          src={first.thumbnailUrl ?? first.url}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="grid h-full w-full place-items-center text-muted">
          <FileText className="h-5 w-5" />
        </div>
      )}

      {isVideo ? (
        <span className="absolute bottom-1.5 end-1.5 grid h-6 w-6 place-items-center rounded-full bg-black/60 text-white">
          <Video className="h-3 w-3" />
        </span>
      ) : null}

      {/* A hairline in the platform's colour, so the platform reads at a glance
          in a grid even before the chip is parsed. */}
      <span className="absolute inset-x-0 top-0 h-[3px]" style={{ background: color }} />
    </div>
  );
}

export interface ContentCardProps {
  post: WorkspacePost;
  view: 'grid' | 'list';
  actions: ContentCardAction[];
  onOpen: () => void;
  /** Quality score from the recommendation report, when it has been fetched. */
  aiScore?: number | null;
}

export function ContentCard({ post, view, actions, onOpen, aiScore }: ContentCardProps) {
  const { lang, t } = useI18n();
  const grid = view === 'grid';
  const color = PLATFORM_COLORS[post.platform] ?? '#94a3b8';
  const type = contentTypeOf(post);

  const caption = post.caption?.trim() || post.headline?.trim() || '';
  const scheduled = post.publishedAt ?? post.scheduledAt;

  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium"
            style={{ borderColor: `${color}44`, background: `${color}18`, color }}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
            {PLATFORM_LABELS[post.platform] ?? humanize(post.platform)}
          </span>
          <span className="rounded-full border border-line px-2 py-0.5 text-[11px] text-muted">
            {tr(t, `ct.${type}`, type)}
          </span>
        </div>
        <Badge tone={STATUS_TONES[post.status] ?? 'neutral'} dot>
          {tr(t, `st.${post.status}`, post.status)}
        </Badge>
      </div>

      <p dir="auto" className="mt-2 line-clamp-2 text-[13.5px] font-medium leading-snug text-fg">
        {caption || <span className="text-muted">{t('library.noCaption')}</span>}
      </p>

      <p dir="auto" className="mt-1 truncate text-[11.5px] text-muted">{post.postGroup.name}</p>

      {/* Only the facts this post actually has. */}
      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted">
        {post.postGroup.campaign ? (
          <span className="inline-flex items-center gap-1 truncate">
            <Sparkles className="h-3 w-3 shrink-0" />
            {post.postGroup.campaign.name}
          </span>
        ) : null}

        {scheduled ? (
          <span className="inline-flex items-center gap-1" dir="ltr">
            <CalendarClock className="h-3 w-3 shrink-0" />
            {dateTime(scheduled, lang)}
          </span>
        ) : null}

        {post.integrationAccount ? (
          <span className="truncate">{post.integrationAccount.name}</span>
        ) : (
          <span className="text-warn">{t('library.noAccount')}</span>
        )}

        {typeof aiScore === 'number' ? (
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5',
              aiScore >= 70 ? 'bg-ok/12 text-ok' : aiScore >= 40 ? 'bg-warn/12 text-warn' : 'bg-danger/12 text-danger',
            )}
            title={t('library.aiScoreHint')}
          >
            <Sparkles className="h-3 w-3" />
            <span className="tabular" dir="ltr">{aiScore}</span>
          </span>
        ) : null}
      </div>

      {post.errorMessage ? (
        <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-danger/10 px-2 py-1.5 text-[11.5px] text-danger">
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
          <span className="line-clamp-2">{post.errorMessage}</span>
        </p>
      ) : null}

      <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-line pt-2">
        <span className="truncate text-[11px] text-muted">
          {t('library.updated')} {relative(post.updatedAt, lang)}
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
          {post.externalUrl ? (
            <a
              href={post.externalUrl}
              target="_blank"
              rel="noreferrer noopener"
              onClick={(event) => event.stopPropagation()}
              className="grid h-8 w-8 place-items-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-fg"
              aria-label={t('library.openOnPlatform')}
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          ) : null}
          <ActionMenu actions={actions} />
        </div>
      </div>
    </>
  );

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        'group cursor-pointer rounded-xl border border-line bg-surface text-start transition-colors',
        'hover:border-brand/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/60',
        grid ? 'overflow-hidden' : 'flex gap-3 p-3',
      )}
    >
      {grid ? (
        <>
          <Thumb post={post} tall />
          <div className="p-3">{body}</div>
        </>
      ) : (
        <>
          <Thumb post={post} tall={false} />
          <div className="min-w-0 flex-1">{body}</div>
        </>
      )}
    </div>
  );
}

/** The icons the workspace hands to `actions`, kept here so pages share them. */
export const ACTION_ICONS = {
  preview: Eye,
  edit: Pencil,
  duplicate: Copy,
  schedule: CalendarClock,
  publish: Send,
  archive: Archive,
  delete: Trash2,
};
