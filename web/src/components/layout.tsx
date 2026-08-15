/** The application shell: sidebar, top bar, mobile navigation. */

import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Bell, CalendarDays, ChartNoAxesCombined, ChevronDown, FileText, Image, LayoutDashboard,
  Languages, ListChecks, LogOut, Megaphone, Menu, Moon, PenLine, Settings, Sparkles, Store,
  Sun, Target, X, type LucideIcon,
} from 'lucide-react';

import { api, qs, type Paginated } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n, type TranslationKey } from '../lib/i18n';
import { useTheme } from '../lib/theme';
import { cn } from '../lib/utils';
import { relative } from '../lib/format';
import { Avatar, useToast } from './ui';

interface NavItem {
  to: string;
  labelKey: TranslationKey;
  icon: LucideIcon;
  end?: boolean;
}

/**
 * One navigation, grouped by what the operator is doing rather than by feature
 * area: the daily production work, then the things that measure it.
 */
const NAV: Array<{ heading: TranslationKey; items: NavItem[] }> = [
  {
    heading: 'nav.overview',
    items: [
      { to: '/dashboard', labelKey: 'nav.dashboard', icon: LayoutDashboard },
      { to: '/restaurants', labelKey: 'nav.restaurants', icon: Store },
    ],
  },
  {
    heading: 'nav.operate',
    items: [
      { to: '/content', labelKey: 'nav.content', icon: PenLine },
      { to: '/campaigns', labelKey: 'nav.campaigns', icon: Megaphone },
      { to: '/ads', labelKey: 'nav.ads', icon: Target },
      { to: '/calendar', labelKey: 'nav.calendar', icon: CalendarDays },
      { to: '/media', labelKey: 'nav.media', icon: Image },
      { to: '/ai', labelKey: 'nav.ai', icon: Sparkles },
      { to: '/tasks', labelKey: 'nav.tasks', icon: ListChecks },
    ],
  },
  {
    heading: 'nav.measure',
    items: [
      { to: '/analytics', labelKey: 'nav.analytics', icon: ChartNoAxesCombined },
      { to: '/reports', labelKey: 'nav.reports', icon: FileText },
      { to: '/settings', labelKey: 'nav.settings', icon: Settings },
    ],
  },
];

function Logo({ collapsed, name }: { collapsed?: boolean; name: string }) {
  return (
    <span className="flex items-center gap-2.5">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-brand to-accent text-white shadow-glow">
        <Sparkles className="h-[18px] w-[18px]" />
      </span>
      {!collapsed ? (
        <span className="min-w-0">
          <span className="block truncate text-[15px] font-semibold leading-tight text-fg">{name}</span>
        </span>
      ) : null}
    </span>
  );
}

function NavSection({ section, onNavigate }: { section: (typeof NAV)[number]; onNavigate?: () => void }) {
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
  const { user, signOut } = useAuth();
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


  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-2 rounded-lg border border-line bg-elevated py-1 pe-2 ps-1 transition-colors hover:border-brand/30"
      >
        <Avatar name={user.name} src={user.avatarUrl} size={28} />
        <span className="hidden min-w-0 text-start sm:block">
          <span className="block max-w-[9rem] truncate text-[13px] font-medium leading-tight text-fg">{user.name}</span>
          <span className="block max-w-[9rem] truncate text-[11px] leading-tight text-muted">{user.email}</span>
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
            </div>

            <div className="py-1">
              <button
                onClick={() => { navigate('/settings'); setOpen(false); }}
                className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] text-muted transition-colors hover:bg-elevated hover:text-fg"
              >
                <Settings className="h-4 w-4" /> {t('nav.settings')}
              </button>
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

export function AppShell({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const { workspace } = useAuth();
  const location = useLocation();
  const { t } = useI18n();

  const workspaceName = workspace?.name ?? t('app.name');

  // Route changes close the mobile drawer; leaving it open feels broken.
  useEffect(() => setMobileOpen(false), [location.pathname]);

  const sidebar = (onNavigate?: () => void) => (
    <div className="flex h-full flex-col">
      <div className="flex h-16 shrink-0 items-center justify-between px-4">
        <Link to="/dashboard" onClick={onNavigate}>
          <Logo name={workspaceName} />
        </Link>
        <button onClick={onNavigate} className="text-muted lg:hidden" aria-label="Close menu">
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {NAV.map((section) => (
          <NavSection key={section.heading} section={section} onNavigate={onNavigate} />
        ))}
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
            <p className="truncate text-sm font-medium text-fg">{workspaceName}</p>
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
