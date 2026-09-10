/** The application shell: sidebar, top bar, mobile navigation. */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Award, BarChart3, Bell, Building2, CalendarDays, ChartNoAxesCombined, ChevronDown, Clapperboard, Compass,
  CornerDownLeft, CreditCard, FileText, Gauge, Image, LayoutDashboard, LayoutGrid, Languages, LogOut, MapPin,
  Megaphone, Menu, Moon, Palette, PenLine, Plug, ScrollText, Search, Settings, Share2, Shield, Sparkles, Store,
  Sun, ThumbsUp, Upload, Users, Wallet, X, type LucideIcon,
} from 'lucide-react';

import { api, qs, type Paginated } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n, type TranslationKey } from '../lib/i18n';
import { useRestaurant } from '../lib/restaurant';
import { useTheme } from '../lib/theme';
import { cn } from '../lib/utils';
import { humanize, relative } from '../lib/format';
import { useDebounced } from '../lib/hooks';
import { Avatar, Badge, useToast } from './ui';
import { CreateButton } from './create-flow';

interface NavItem {
  to: string;
  labelKey: TranslationKey;
  icon: LucideIcon;
  end?: boolean;
  /**
   * Sub-entries, shown indented while the parent's section of the app is open.
   *
   * Only one level deep, and deliberately so: the platform views under Content
   * are the one place in this product where a second level earns its keep,
   * because "everything on Instagram" is somewhere an operator returns to. A
   * third level would be a menu, and menus hide things.
   */
  children?: NavItem[];
}

/*
 * The operator's navigation.
 *
 * One flat list, in the order the work happens: look at the day, then the
 * clients, then the plan, then the things you make, then the money, then the
 * numbers you report. A flat rail beats grouped headings here because the
 * groups were carrying no information the icons and order did not already —
 * they only pushed the fifteenth entry below the fold.
 *
 * Every entry points at a surface that exists. Where a label in the product
 * brief names something this deployment reaches by another route — Strategy is
 * the Brand DNA, Social Media is the platform workspaces — the entry maps onto
 * that route rather than a new empty page. Sub-entries are revealed by
 * location, so the rail stays fifteen rows until you are inside a section.
 */
const AGENCY_NAV: Array<{ heading?: TranslationKey; items: NavItem[] }> = [
  {
    items: [
      { to: '/app/dashboard', labelKey: 'nav.dashboard', icon: LayoutDashboard },
      { to: '/app/restaurants', labelKey: 'nav.clients', icon: Users },
      {
        // The Brand DNA is where this product keeps business context, audience,
        // positioning and content direction — the strategy, under its own name.
        to: '/app/brand',
        labelKey: 'nav.strategy',
        icon: Compass,
      },
      { to: '/app/campaigns', labelKey: 'nav.campaigns', icon: Megaphone },
      {
        to: '/app/content',
        labelKey: 'nav.content',
        icon: FileText,
        children: [
          { to: '/app/social', labelKey: 'nav.composer', icon: PenLine },
          { to: '/app/library', labelKey: 'nav.commandCenter', icon: LayoutGrid },
          { to: '/app/studio', labelKey: 'nav.aiContent', icon: Sparkles },
        ],
      },
      { to: '/app/marketing/calendar', labelKey: 'nav.calendar', icon: CalendarDays },
      {
        to: '/app/marketing',
        labelKey: 'nav.socialMedia',
        icon: Share2,
        end: true,
        children: [
          { to: '/app/marketing/meta', labelKey: 'nav.meta', icon: Share2 },
          { to: '/app/marketing/tiktok', labelKey: 'nav.tiktok', icon: Share2 },
          { to: '/app/marketing/google', labelKey: 'nav.google', icon: MapPin },
          { to: '/app/marketing/youtube', labelKey: 'nav.youtube', icon: Clapperboard },
          { to: '/app/marketing/linkedin', labelKey: 'nav.linkedin', icon: Share2 },
          { to: '/app/marketing/snapchat', labelKey: 'nav.snapchat', icon: Share2 },
          { to: '/app/social/analytics', labelKey: 'nav.socialAnalytics', icon: BarChart3 },
        ],
      },
      {
        to: '/app/marketing/advertising',
        labelKey: 'nav.advertising',
        icon: Wallet,
        end: true,
        children: [
          { to: '/app/marketing/advertising/creatives', labelKey: 'nav.adCreatives', icon: LayoutGrid },
          { to: '/app/marketing/advertising/calendar', labelKey: 'nav.adCalendar', icon: CalendarDays },
          { to: '/app/creative-performance', labelKey: 'nav.creativePerformance', icon: Award },
        ],
      },
      {
        to: '/app/analytics',
        labelKey: 'nav.analytics',
        icon: ChartNoAxesCombined,
        children: [
          { to: '/app/ceo', labelKey: 'nav.ceo', icon: Gauge },
          { to: '/app/google', labelKey: 'nav.googleOverview', icon: MapPin },
        ],
      },
      {
        to: '/app/reports',
        labelKey: 'nav.reports',
        icon: ScrollText,
        end: true,
        children: [
          { to: '/app/reports/builders', labelKey: 'nav.reportBuilder', icon: FileText },
        ],
      },
      { to: '/app/marketing/advertising/ai', labelKey: 'nav.aiAssistant', icon: Sparkles },
      { to: '/app/integrations', labelKey: 'nav.integrations', icon: Plug },
      {
        to: '/app/media',
        labelKey: 'nav.brandAssets',
        icon: Image,
        children: [
          { to: '/app/creatives', labelKey: 'nav.creatives', icon: Upload },
          { to: '/app/image-ads', labelKey: 'nav.imageAds', icon: Image },
          { to: '/app/video-ads', labelKey: 'nav.videoAds', icon: Clapperboard },
        ],
      },
      { to: '/app/team', labelKey: 'nav.team', icon: Users },
      { to: '/app/settings', labelKey: 'nav.settings', icon: Settings },
    ],
  },
];


const CLIENT_NAV: Array<{ heading: TranslationKey; items: NavItem[] }> = [
  {
    heading: 'group.workspace',
    items: [
      { to: '/client/dashboard', labelKey: 'nav.home', icon: LayoutDashboard },
      { to: '/client/brand', labelKey: 'nav.brandDna', icon: Palette },
      { to: '/client/approvals', labelKey: 'nav.reviews', icon: ThumbsUp },
    ],
  },
  {
    heading: 'group.marketing',
    items: [
      { to: '/client/campaigns', labelKey: 'nav.campaigns', icon: Megaphone },
      { to: '/client/content', labelKey: 'nav.organicContent', icon: PenLine },
      { to: '/client/calendar', labelKey: 'nav.calendar', icon: CalendarDays },
    ],
  },
  {
    heading: 'group.insights',
    items: [
      { to: '/client/analytics', labelKey: 'nav.analytics', icon: ChartNoAxesCombined },
      { to: '/client/ceo', labelKey: 'nav.ceo', icon: Gauge },
      { to: '/client/reports', labelKey: 'nav.reports', icon: FileText },
    ],
  },
];

const ADMIN_NAV: Array<{ heading: TranslationKey; items: NavItem[] }> = [
  {
    heading: 'nav.admin',
    items: [
      { to: '/admin/dashboard', labelKey: 'nav.dashboard', icon: Shield },
      { to: '/admin/clients', labelKey: 'nav.clients', icon: Building2 },
      { to: '/admin/users', labelKey: 'nav.users', icon: Users },
      { to: '/admin/plans', labelKey: 'nav.plans', icon: CreditCard },
      { to: '/admin/subscriptions', labelKey: 'nav.subscriptions', icon: FileText },
      { to: '/admin/settings', labelKey: 'nav.settings', icon: Settings },
      { to: '/admin/audit', labelKey: 'nav.audit', icon: ScrollText },
    ],
  },
];

function Logo({ collapsed }: { collapsed?: boolean }) {
  const { t } = useI18n();
  return (
    <span className="flex items-center gap-2.5">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-gradient-to-br from-brand to-secondary text-white">
        <Sparkles className="h-[18px] w-[18px]" />
      </span>
      {!collapsed ? (
        <span className="min-w-0">
          <span className="block truncate text-[15px] font-semibold leading-tight text-fg">Marketing OS</span>
          <span className="block truncate text-[11px] leading-tight text-muted">{t('app.railTagline')}</span>
        </span>
      ) : null}
    </span>
  );
}

/**
 * One nav row, plus its children when it has them.
 *
 * Children are revealed by location rather than by a disclosure control: an
 * operator inside Content wants its platform views to hand, and everyone else
 * wants them out of the way. A chevron would make that a thing to click before
 * the thing they came to click.
 */
function NavEntry({ item, onNavigate }: { item: NavItem; onNavigate?: () => void }) {
  const { t } = useI18n();
  const location = useLocation();
  const withinSection = location.pathname.startsWith(item.to);

  return (
    <>
      <NavLink
        to={item.to}
        end={item.end}
        onClick={onNavigate}
        className={({ isActive }) =>
          cn(
            'group flex items-center gap-3 rounded-[10px] px-3 py-[9px] text-[13.5px] transition-colors',
            isActive
              ? 'bg-brand/90 font-medium text-white'
              : 'text-muted hover:bg-elevated hover:text-fg',
          )
        }
      >
        <item.icon className="h-[17px] w-[17px] shrink-0" />
        <span className="truncate">{t(item.labelKey)}</span>
      </NavLink>

      {item.children && withinSection ? (
        // Indented with a logical property so the tree mirrors under Arabic.
        <div className="ms-[26px] space-y-0.5 border-s border-line ps-2.5">
          {item.children.map((child) => (
            <NavLink
              key={child.to}
              to={child.to}
              onClick={onNavigate}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[12.5px] transition-colors',
                  isActive ? 'font-medium text-fg' : 'text-muted hover:text-fg',
                )
              }
            >
              <span className="truncate">{t(child.labelKey)}</span>
            </NavLink>
          ))}
        </div>
      ) : null}
    </>
  );
}

function NavSection({
  section, onNavigate,
}: { section: { heading?: TranslationKey; items: NavItem[] }; onNavigate?: () => void }) {
  const { t } = useI18n();
  return (
    <div className={cn(section.heading ? 'mb-5' : 'mb-2')}>
      {section.heading ? (
        <p className="mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-wider text-muted/70">
          {t(section.heading)}
        </p>
      ) : null}
      <nav className="space-y-0.5">
        {section.items.map((item) => (
          <NavEntry key={item.to} item={item} onNavigate={onNavigate} />
        ))}
      </nav>
    </div>
  );
}

/**
 * The restaurant this session is working on.
 *
 * Sits in the top bar rather than on each page because it is the frame for
 * everything underneath it: the campaigns you see, the posts, the assets, the
 * connected accounts. "All restaurants" stays available — the roll-up view is
 * the reason the home dashboard exists.
 */
function RestaurantSwitch() {
  const { restaurants, currentId, current, setCurrentId, loading } = useRestaurant();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  // Nothing to switch between until there is something to switch between.
  if (loading || restaurants.length === 0) return null;

  const choose = (id: string) => {
    setCurrentId(id);
    setOpen(false);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((value) => !value)}
        className="flex h-11 w-full max-w-[11rem] items-center gap-2.5 rounded-[10px] border border-line bg-surface px-2.5 text-[13px] transition-colors hover:border-brand/40 sm:max-w-[15rem]"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {current ? (
          <Avatar name={current.businessName} src={current.logoUrl} size={26} />
        ) : (
          <span className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-lg bg-brand/10 text-brand">
            <Store className="h-3.5 w-3.5" />
          </span>
        )}
        <span className="min-w-0 text-start">
          <span className="block truncate font-medium leading-tight text-fg">
            {current ? current.businessName : t('restaurant.all')}
          </span>
          {/* The location, where the project records one — the reference's
              second line, and never invented when the field is empty. It is the
              first thing to go when the bar is narrow. */}
          <span className="hidden truncate text-[11px] leading-tight text-muted sm:block">
            {current?.location ?? t('restaurant.allSub')}
          </span>
        </span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted" />
      </button>

      <AnimatePresence>
        {open ? (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.15 }}
            role="listbox"
            className="absolute start-0 z-50 mt-2 max-h-80 w-[min(18rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border border-line bg-surface p-1.5 shadow-lift"
          >
            <button
              role="option"
              aria-selected={currentId === ''}
              onClick={() => choose('')}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-start text-[13px] transition-colors hover:bg-elevated',
                currentId === '' ? 'font-medium text-brand' : 'text-muted',
              )}
            >
              <Store className="h-4 w-4 shrink-0" />
              {t('restaurant.all')}
            </button>
            {restaurants.map((row) => (
              <button
                key={row.id}
                role="option"
                aria-selected={currentId === row.id}
                onClick={() => choose(row.id)}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-start text-[13px] transition-colors hover:bg-elevated',
                  currentId === row.id ? 'font-medium text-brand' : 'text-fg',
                )}
              >
                <Avatar name={row.businessName} src={row.logoUrl} size={22} />
                <span className="min-w-0">
                  <span className="block truncate">{row.businessName}</span>
                  {row.location ? (
                    <span className="block truncate text-[11px] text-muted">{row.location}</span>
                  ) : null}
                </span>
              </button>
            ))}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/**
 * Global search.
 *
 * Deliberately small: it searches the two things an operator actually looks for
 * by name — a place in the product, and a client — plus campaigns, which the
 * campaigns endpoint already searches server-side. Nothing here pretends to
 * search content it cannot reach; a result you can click is a result that
 * navigates somewhere real.
 */
interface SearchHit {
  id: string;
  label: string;
  detail?: string | null;
  icon: LucideIcon;
  run: () => void;
}

function GlobalSearch() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { restaurants, setCurrentId } = useRestaurant();
  const { isAgency } = useAuth();
  const [term, setTerm] = useState('');
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [campaigns, setCampaigns] = useState<Array<{ id: string; name: string; status: string }>>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const ref = useRef<HTMLDivElement>(null);
  const query = useDebounced(term.trim(), 250);

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  // ⌘K / Ctrl-K, the shortcut every operator already has in their fingers.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!isAgency || query.length < 2) {
      setCampaigns([]);
      return;
    }
    let cancelled = false;
    api
      .get<Paginated<{ id: string; name: string; status: string }>>(`/campaigns${qs({ search: query, pageSize: 4 })}`)
      .then((data) => { if (!cancelled) setCampaigns(data.items); })
      .catch(() => { if (!cancelled) setCampaigns([]); });
    return () => { cancelled = true; };
  }, [query, isAgency]);

  const hits = useMemo<SearchHit[]>(() => {
    const needle = query.toLowerCase();
    if (needle.length < 1) return [];
    const results: SearchHit[] = [];

    for (const item of AGENCY_NAV.flatMap((section) => section.items)) {
      if (!isAgency) break;
      const label = t(item.labelKey);
      if (label.toLowerCase().includes(needle)) {
        results.push({ id: `nav:${item.to}`, label, detail: item.to, icon: item.icon, run: () => navigate(item.to) });
      }
    }

    for (const row of restaurants) {
      if (
        row.businessName.toLowerCase().includes(needle)
        || row.name.toLowerCase().includes(needle)
        || (row.location ?? '').toLowerCase().includes(needle)
      ) {
        results.push({
          id: `client:${row.id}`,
          label: row.businessName,
          detail: row.location,
          icon: Store,
          run: () => { setCurrentId(row.id); navigate(`/app/restaurants/${row.id}`); },
        });
      }
    }

    for (const row of campaigns) {
      results.push({
        id: `campaign:${row.id}`,
        label: row.name,
        detail: humanize(row.status.toLowerCase()),
        icon: Megaphone,
        run: () => navigate(`/app/campaigns/${row.id}`),
      });
    }

    return results.slice(0, 8);
  }, [query, restaurants, campaigns, isAgency, navigate, setCurrentId, t]);

  useEffect(() => setCursor(0), [query]);

  const choose = (hit: SearchHit) => {
    hit.run();
    setTerm('');
    setOpen(false);
    inputRef.current?.blur();
  };

  return (
    <div className="relative w-full" ref={ref}>
      <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
      <input
        ref={inputRef}
        value={term}
        onChange={(event) => { setTerm(event.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { setOpen(false); inputRef.current?.blur(); return; }
          if (hits.length === 0) return;
          if (event.key === 'ArrowDown') { event.preventDefault(); setCursor((value) => (value + 1) % hits.length); }
          if (event.key === 'ArrowUp') { event.preventDefault(); setCursor((value) => (value - 1 + hits.length) % hits.length); }
          if (event.key === 'Enter') {
            const hit = hits[cursor];
            if (hit) { event.preventDefault(); choose(hit); }
          }
        }}
        placeholder={t('search.placeholder')}
        aria-label={t('search.placeholder')}
        className="h-10 w-full rounded-[10px] border border-line bg-elevated ps-9 pe-3 text-[13px] text-fg outline-none transition-colors placeholder:text-muted focus:border-brand/50"
      />

      <AnimatePresence>
        {open && query.length > 0 ? (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.12 }}
            className="absolute inset-x-0 z-50 mt-2 overflow-hidden rounded-xl border border-line bg-surface p-1.5 shadow-lift"
          >
            {hits.length === 0 ? (
              <p className="px-3 py-4 text-center text-[13px] text-muted">{t('search.empty')}</p>
            ) : (
              hits.map((hit, index) => (
                <button
                  key={hit.id}
                  onMouseEnter={() => setCursor(index)}
                  onClick={() => choose(hit)}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-start text-[13px] transition-colors',
                    index === cursor ? 'bg-elevated text-fg' : 'text-muted hover:bg-elevated',
                  )}
                >
                  <hit.icon className="h-4 w-4 shrink-0 text-muted" />
                  <span className="min-w-0 flex-1 truncate" dir="auto">{hit.label}</span>
                  {hit.detail ? (
                    <span className="hidden max-w-[10rem] truncate text-[11px] text-muted sm:block" dir="auto">
                      {hit.detail}
                    </span>
                  ) : null}
                  {index === cursor ? <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-muted" /> : null}
                </button>
              ))
            )}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function ThemeSwitch() {
  const { mode, setMode } = useTheme();
  const { t } = useI18n();
  const options = [
    { value: 'light' as const, icon: Sun, label: t('theme.light') },
    { value: 'dark' as const, icon: Moon, label: t('theme.dark') },
    { value: 'system' as const, icon: Settings, label: t('theme.system') },
  ];

  return (
    <div className="flex rounded-lg border border-line bg-elevated p-0.5" role="group" aria-label={t('theme.label')}>
      {options.map((option) => (
        <button
          key={option.value}
          onClick={() => setMode(option.value)}
          title={option.label}
          aria-pressed={mode === option.value}
          className={cn(
            'grid h-7 w-8 place-items-center rounded-md transition-colors',
            mode === option.value ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:text-fg',
          )}
        >
          <option.icon className="h-3.5 w-3.5" />
        </button>
      ))}
    </div>
  );
}

function LanguageSwitch() {
  const { lang, setLang } = useI18n();
  return (
    <button
      onClick={() => setLang(lang === 'en' ? 'ar' : 'en')}
      className="flex h-9 items-center gap-1.5 rounded-lg border border-line bg-elevated px-2.5 text-[13px] font-medium text-muted transition-colors hover:text-fg"
      title={lang === 'en' ? 'التبديل إلى العربية' : 'Switch to English'}
    >
      <Languages className="h-4 w-4" />
      {lang === 'en' ? 'EN' : 'ع'}
    </button>
  );
}

interface NotificationRow {
  id: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationRow[]>([]);
  const [unread, setUnread] = useState(0);
  const navigate = useNavigate();
  const { lang, t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);

  const load = async () => {
    try {
      const data = await api.get<Paginated<NotificationRow> & { unread: number }>(
        `/notifications${qs({ pageSize: 8 })}`,
      );
      setItems(data.items);
      setUnread(data.unread);
    } catch {
      /* the bell is not worth surfacing an error for */
    }
  };

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const markAll = async () => {
    await api.post('/notifications/read-all');
    void load();
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((value) => !value)}
        className="relative grid h-9 w-9 place-items-center rounded-lg border border-line bg-elevated text-muted transition-colors hover:text-fg"
        aria-label={t('notif.title')}
      >
        <Bell className="h-4 w-4" />
        {unread > 0 ? (
          <span className="absolute -end-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-danger px-1 text-[10px] font-bold text-white">
            {unread > 9 ? '9+' : unread}
          </span>
        ) : null}
      </button>

      <AnimatePresence>
        {open ? (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.15 }}
            className="absolute end-0 z-50 mt-2 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-line bg-surface shadow-lift"
          >
            <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
              <p className="text-sm font-semibold">{t('notif.title')}</p>
              {unread > 0 ? (
                <button onClick={markAll} className="text-[12px] text-brand hover:underline">
                  {t('notif.markAll')}
                </button>
              ) : null}
            </div>
            <div className="max-h-80 overflow-y-auto">
              {items.length === 0 ? (
                <p className="px-4 py-8 text-center text-[13px] text-muted">{t('notif.empty')}</p>
              ) : (
                items.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => {
                      void api.post(`/notifications/${item.id}/read`).then(load);
                      if (item.link) navigate(item.link);
                      setOpen(false);
                    }}
                    className={cn(
                      'flex w-full gap-3 border-b border-line/60 px-4 py-3 text-start transition-colors last:border-0 hover:bg-elevated',
                      !item.readAt && 'bg-brand/[0.04]',
                    )}
                  >
                    <span className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', item.readAt ? 'bg-transparent' : 'bg-brand')} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium text-fg">{item.title}</span>
                      {item.body ? <span className="mt-0.5 block text-[12px] text-muted">{item.body}</span> : null}
                      <span className="mt-1 block text-[11px] text-muted/80">{relative(item.createdAt, lang)}</span>
                    </span>
                  </button>
                ))
              )}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function UserMenu({ placement = 'bar' }: { placement?: 'bar' | 'rail' }) {
  const { user, signOut, isSuperAdmin, isClientUser } = useAuth();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { push } = useToast();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  if (!user) return null;

  const roleLabel = user.role.replace(/_/g, ' ').toLowerCase();

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'flex items-center gap-2 transition-colors',
          placement === 'rail'
            ? 'w-full rounded-[10px] border border-line bg-elevated p-2 hover:border-brand/40'
            : 'rounded-[10px] border border-line bg-elevated py-1 pe-2 ps-1 hover:border-brand/30',
        )}
      >
        <Avatar name={user.name} src={user.avatarUrl} size={placement === 'rail' ? 32 : 28} />
        <span
          className={cn(
            'min-w-0 flex-1 text-start',
            placement === 'rail' ? 'block' : 'hidden sm:block',
          )}
        >
          <span className="block max-w-[9rem] truncate text-[13px] font-medium leading-tight text-fg">{user.name}</span>
          <span className="block text-[11px] capitalize leading-tight text-muted">{roleLabel}</span>
        </span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted" />
      </button>

      <AnimatePresence>
        {open ? (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.15 }}
            className={cn(
              'absolute z-50 w-60 overflow-hidden rounded-xl border border-line bg-surface p-1.5 shadow-lift',
              placement === 'rail' ? 'bottom-full start-0 mb-2' : 'end-0 mt-2',
            )}
          >
            <div className="border-b border-line px-3 py-2.5">
              <p className="truncate text-sm font-medium text-fg">{user.name}</p>
              <p className="truncate text-[12px] text-muted">{user.email}</p>
              {user.organization ? (
                <Badge tone="brand" className="mt-2">{user.organization.name}</Badge>
              ) : null}
            </div>

            <div className="py-1">
              {!isClientUser ? (
                <button
                  onClick={() => { navigate('/app/settings'); setOpen(false); }}
                  className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] text-muted transition-colors hover:bg-elevated hover:text-fg"
                >
                  <Settings className="h-4 w-4" /> {t('nav.settings')}
                </button>
              ) : null}
              {isSuperAdmin ? (
                <button
                  onClick={() => { navigate('/admin/dashboard'); setOpen(false); }}
                  className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] text-muted transition-colors hover:bg-elevated hover:text-fg"
                >
                  <Shield className="h-4 w-4" /> {t('nav.admin')}
                </button>
              ) : null}
              <button
                onClick={async () => {
                  await signOut();
                  push({ tone: 'info', title: 'Signed out' });
                  navigate('/login');
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] text-danger transition-colors hover:bg-danger/10"
              >
                <LogOut className="h-4 w-4" /> {t('auth.signOut')}
              </button>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

export function AppShell({ children, variant }: { children: React.ReactNode; variant: 'agency' | 'client' | 'admin' }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const { user, isSuperAdmin } = useAuth();
  const location = useLocation();
  const { t } = useI18n();

  const sections = useMemo<Array<{ heading?: TranslationKey; items: NavItem[] }>>(() => {
    if (variant === 'admin') return ADMIN_NAV;
    if (variant === 'client') return CLIENT_NAV;
    return AGENCY_NAV;
  }, [variant]);

  // Route changes close the mobile drawer; leaving it open feels broken.
  useEffect(() => setMobileOpen(false), [location.pathname]);

  /*
   * The rail.
   *
   * Dark against the light workspace, and dark in either theme — it is chrome,
   * and chrome that changes colour with the content it frames stops reading as
   * a frame. The identity sits at the top, the work in the middle, the person
   * signed in at the bottom, which is where a person looks for themselves.
   */
  const sidebar = (onNavigate?: () => void) => (
    <div className="rail flex h-full flex-col">
      <div className="flex h-16 shrink-0 items-center justify-between px-4">
        <Link to={variant === 'client' ? '/client/dashboard' : variant === 'admin' ? '/admin/dashboard' : '/app/dashboard'}>
          <Logo />
        </Link>
        <button onClick={onNavigate} className="text-muted lg:hidden" aria-label="Close menu">
          <X className="h-5 w-5" />
        </button>
      </div>

      {variant === 'client' && user?.client ? (
        <div className="mx-3 mb-3 flex items-center gap-2.5 rounded-[10px] border border-line bg-elevated p-2.5">
          <Avatar name={user.client.businessName} src={user.client.logoUrl} size={32} />
          <div className="min-w-0">
            <p className="truncate text-[13px] font-medium text-fg">{user.client.businessName}</p>
            <p className="text-[11px] text-muted">{t('nav.clientPortal')}</p>
          </div>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {sections.map((section, index) => (
          <NavSection key={section.heading ?? index} section={section} onNavigate={onNavigate} />
        ))}

        {variant === 'admin' ? (
          <Link
            to="/app/dashboard"
            onClick={onNavigate}
            className="flex items-center gap-3 rounded-[10px] px-3 py-2 text-[13.5px] text-muted transition-colors hover:bg-elevated hover:text-fg"
          >
            <LayoutDashboard className="h-[17px] w-[17px]" /> {t('nav.workspace')}
          </Link>
        ) : isSuperAdmin && variant === 'agency' ? (
          <Link
            to="/admin/dashboard"
            onClick={onNavigate}
            className="flex items-center gap-3 rounded-[10px] border border-dashed border-line px-3 py-2 text-[13.5px] text-muted transition-colors hover:border-brand/40 hover:text-brand"
          >
            <Shield className="h-[17px] w-[17px]" /> {t('nav.admin')}
          </Link>
        ) : null}
      </div>

      {/* The person signed in, and the menu that belongs to them. */}
      <div className="shrink-0 border-t border-line p-3">
        <UserMenu placement="rail" />
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-bg">
      {/* Desktop rail */}
      <aside className="fixed inset-y-0 start-0 z-30 hidden w-[248px] lg:block">
        {sidebar()}
      </aside>

      {/* Mobile drawer */}
      <AnimatePresence>
        {mobileOpen ? (
          <div className="fixed inset-0 z-50 lg:hidden">
            <motion.div
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setMobileOpen(false)}
            />
            <motion.aside
              className="absolute inset-y-0 start-0 w-[17rem]"
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ type: 'spring', damping: 30, stiffness: 320 }}
            >
              {sidebar(() => setMobileOpen(false))}
            </motion.aside>
          </div>
        ) : null}
      </AnimatePresence>

      <div className="lg:ps-[248px]">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-2 overflow-hidden border-b border-line bg-surface px-4 sm:gap-3 sm:px-6">
          <button
            onClick={() => setMobileOpen(true)}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] border border-line bg-elevated text-muted lg:hidden"
            aria-label="Open menu"
          >
            <Menu className="h-4 w-4" />
          </button>

          {/* Left: what this session is pointed at. */}
          <div className="min-w-0 flex-1 md:flex-none">
            {variant === 'admin' ? (
              <Badge tone="danger" dot>Super Admin</Badge>
            ) : variant === 'agency' ? (
              <RestaurantSwitch />
            ) : user?.organization ? (
              <p className="truncate text-sm font-medium text-fg">{user.organization.name}</p>
            ) : null}
          </div>

          {/* Middle: search. Agency-side only — a portal user has one client
              and three screens, and a search box over that is furniture. */}
          {variant === 'agency' ? (
            <div className="mx-auto hidden w-full max-w-lg md:block"><GlobalSearch /></div>
          ) : (
            <div className="flex-1" />
          )}

          <div className="ms-auto flex shrink-0 items-center gap-2">
            {variant === 'agency' ? (
              <div className="hidden sm:block"><CreateButton /></div>
            ) : null}
            <div className="hidden lg:block"><ThemeSwitch /></div>
            <LanguageSwitch />
            <NotificationBell />
            <UserMenu />
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1600px] px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}

export { ThemeSwitch, LanguageSwitch };
