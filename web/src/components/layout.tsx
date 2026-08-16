/** The application shell: sidebar, top bar, mobile navigation. */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Bell, Building2, CalendarDays, ChartNoAxesCombined, ChevronDown, CreditCard, FileText, Gauge, Image,
  LayoutDashboard, Languages, LogOut, Megaphone, Menu, Moon, Palette, PenLine, ScrollText,
  Settings, Shield, Sparkles, Store, Sun, ThumbsUp, Users, X, type LucideIcon,
} from 'lucide-react';

import { api, qs, type Paginated } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n, type TranslationKey } from '../lib/i18n';
import { useRestaurant } from '../lib/restaurant';
import { useTheme } from '../lib/theme';
import { cn } from '../lib/utils';
import { relative } from '../lib/format';
import { Avatar, Badge, useToast } from './ui';

interface NavItem {
  to: string;
  labelKey: TranslationKey;
  icon: LucideIcon;
  end?: boolean;
}

/*
 * The operator's navigation.
 *
 * Grouped by what you came here to do rather than by which database table the
 * page reads, which is why Campaigns and Organic Content sit together under
 * Marketing while the studio pages that produce them sit under Create.
 *
 * Two entries are deliberately gone from the top level. "Clients" is now
 * Restaurants — the same page and the same API, named for what it holds.
 * "Approvals" was a whole section for a field on a piece of content; review
 * state now lives with the content it belongs to, and the page itself is still
 * routed and still reachable, just not competing for a slot in the primary nav.
 */
const AGENCY_NAV: Array<{ heading: TranslationKey; items: NavItem[] }> = [
  {
    heading: 'group.workspace',
    items: [
      { to: '/app/dashboard', labelKey: 'nav.home', icon: LayoutDashboard },
      { to: '/app/restaurants', labelKey: 'nav.restaurants', icon: Store },
      { to: '/app/brand', labelKey: 'nav.brandDna', icon: Palette },
      { to: '/app/media', labelKey: 'nav.assets', icon: Image },
    ],
  },
  {
    heading: 'group.create',
    items: [
      { to: '/app/image-ads', labelKey: 'nav.imageAds', icon: Image },
      { to: '/app/studio', labelKey: 'nav.aiContent', icon: Sparkles },
    ],
  },
  {
    heading: 'group.marketing',
    items: [
      { to: '/app/campaigns', labelKey: 'nav.campaigns', icon: Megaphone },
      { to: '/app/content', labelKey: 'nav.organicContent', icon: PenLine },
    ],
  },
  {
    heading: 'group.social',
    items: [
      { to: '/app/calendar', labelKey: 'nav.calendar', icon: CalendarDays },
    ],
  },
  {
    heading: 'group.insights',
    items: [
      { to: '/app/analytics', labelKey: 'nav.analytics', icon: ChartNoAxesCombined },
      { to: '/app/ceo', labelKey: 'nav.ceo', icon: Gauge },
      { to: '/app/reports', labelKey: 'nav.reports', icon: FileText },
    ],
  },
  {
    heading: 'group.operations',
    items: [
      { to: '/app/notifications', labelKey: 'nav.notifications', icon: Bell },
    ],
  },
  {
    heading: 'group.settings',
    items: [
      { to: '/app/integrations', labelKey: 'nav.integrations', icon: CreditCard },
      { to: '/app/settings', labelKey: 'nav.settings', icon: Settings },
    ],
  },
];

/*
 * The portal keeps its review queue in the nav: a portal user's whole reason to
 * be here is to look at work and say yes or no to it.
 */
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
  return (
    <span className="flex items-center gap-2.5">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-brand to-accent text-white shadow-glow">
        <Sparkles className="h-[18px] w-[18px]" />
      </span>
      {!collapsed ? (
        <span className="min-w-0">
          <span className="block truncate text-[15px] font-semibold leading-tight text-fg">Marketing OS</span>
        </span>
      ) : null}
    </span>
  );
}

function NavSection({ section, onNavigate }: { section: (typeof AGENCY_NAV)[number]; onNavigate?: () => void }) {
  const { t } = useI18n();
  return (
    <div className="mb-5">
      <p className="mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-wider text-muted/70">
        {t(section.heading)}
      </p>
      <nav className="space-y-0.5">
        {section.items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                'group relative flex items-center gap-3 rounded-xl px-3 py-2 text-sm transition-colors',
                isActive ? 'bg-brand/12 font-medium text-brand' : 'text-muted hover:bg-elevated hover:text-fg',
              )
            }
          >
            {({ isActive }) => (
              <>
                {isActive ? (
                  <motion.span
                    layoutId="nav-active"
                    className="absolute inset-y-1.5 start-0 w-0.5 rounded-full bg-brand"
                  />
                ) : null}
                <item.icon className="h-[18px] w-[18px] shrink-0" />
                <span className="truncate">{t(item.labelKey)}</span>
              </>
            )}
          </NavLink>
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
        className="flex h-9 max-w-[13rem] items-center gap-2 rounded-lg border border-line bg-elevated px-2.5 text-[13px] transition-colors hover:border-brand/30"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {current ? (
          <Avatar name={current.businessName} src={current.logoUrl} size={20} />
        ) : (
          <Store className="h-4 w-4 shrink-0 text-muted" />
        )}
        <span className="min-w-0 truncate font-medium text-fg">
          {current ? current.businessName : t('restaurant.all')}
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
                <Avatar name={row.businessName} src={row.logoUrl} size={20} />
                <span className="min-w-0 truncate">{row.businessName}</span>
              </button>
            ))}
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
  const { lang } = useI18n();
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
        aria-label="Notifications"
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
              <p className="text-sm font-semibold">Notifications</p>
              {unread > 0 ? (
                <button onClick={markAll} className="text-[12px] text-brand hover:underline">
                  Mark all read
                </button>
              ) : null}
            </div>
            <div className="max-h-80 overflow-y-auto">
              {items.length === 0 ? (
                <p className="px-4 py-8 text-center text-[13px] text-muted">Nothing yet.</p>
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

function UserMenu() {
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
        className="flex items-center gap-2 rounded-lg border border-line bg-elevated py-1 pe-2 ps-1 transition-colors hover:border-brand/30"
      >
        <Avatar name={user.name} src={user.avatarUrl} size={28} />
        <span className="hidden min-w-0 text-start sm:block">
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
            className="absolute end-0 z-50 mt-2 w-60 overflow-hidden rounded-xl border border-line bg-surface p-1.5 shadow-lift"
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

  const sections = useMemo(() => {
    if (variant === 'admin') return ADMIN_NAV;
    if (variant === 'client') return CLIENT_NAV;
    return AGENCY_NAV;
  }, [variant]);

  // Route changes close the mobile drawer; leaving it open feels broken.
  useEffect(() => setMobileOpen(false), [location.pathname]);

  const sidebar = (onNavigate?: () => void) => (
    <div className="flex h-full flex-col">
      <div className="flex h-16 shrink-0 items-center justify-between px-4">
        <Link to={variant === 'client' ? '/client/dashboard' : variant === 'admin' ? '/admin/dashboard' : '/app/dashboard'}>
          <Logo />
        </Link>
        <button onClick={onNavigate} className="text-muted lg:hidden" aria-label="Close menu">
          <X className="h-5 w-5" />
        </button>
      </div>

      {variant === 'client' && user?.client ? (
        <div className="mx-3 mb-4 flex items-center gap-2.5 rounded-xl border border-line bg-elevated p-2.5">
          <Avatar name={user.client.businessName} src={user.client.logoUrl} size={32} />
          <div className="min-w-0">
            <p className="truncate text-[13px] font-medium text-fg">{user.client.businessName}</p>
            <p className="text-[11px] text-muted">{t('nav.clientPortal')}</p>
          </div>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {sections.map((section) => (
          <NavSection key={section.heading} section={section} onNavigate={onNavigate} />
        ))}

        {variant === 'admin' ? (
          <Link
            to="/app/dashboard"
            onClick={onNavigate}
            className="flex items-center gap-3 rounded-xl px-3 py-2 text-sm text-muted transition-colors hover:bg-elevated hover:text-fg"
          >
            <LayoutDashboard className="h-[18px] w-[18px]" /> Back to workspace
          </Link>
        ) : isSuperAdmin && variant === 'agency' ? (
          <Link
            to="/admin/dashboard"
            onClick={onNavigate}
            className="flex items-center gap-3 rounded-xl border border-dashed border-line px-3 py-2 text-sm text-muted transition-colors hover:border-brand/40 hover:text-brand"
          >
            <Shield className="h-[18px] w-[18px]" /> {t('nav.admin')}
          </Link>
        ) : null}
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-bg">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 start-0 z-30 hidden w-64 border-e border-line bg-surface lg:block">
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
              className="absolute inset-y-0 start-0 w-[17rem] border-e border-line bg-surface"
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

      <div className="lg:ps-64">
        <header className="glass sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-line px-4 sm:px-6">
          <button
            onClick={() => setMobileOpen(true)}
            className="grid h-9 w-9 place-items-center rounded-lg border border-line bg-elevated text-muted lg:hidden"
            aria-label="Open menu"
          >
            <Menu className="h-4 w-4" />
          </button>

          <div className="min-w-0 flex-1">
            {variant === 'admin' ? (
              <Badge tone="danger" dot>Super Admin</Badge>
            ) : variant === 'agency' ? (
              <RestaurantSwitch />
            ) : user?.organization ? (
              <p className="truncate text-sm font-medium text-fg">{user.organization.name}</p>
            ) : null}
          </div>

          <div className="flex items-center gap-2">
            <div className="hidden sm:block"><ThemeSwitch /></div>
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
