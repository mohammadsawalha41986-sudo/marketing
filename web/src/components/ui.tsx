/** Design-system primitives. Everything the pages are built from. */

import {
  createContext, forwardRef, useCallback, useContext, useEffect, useId, useMemo, useState,
  type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertCircle, Check, ChevronDown, Info, Loader2, X, type LucideIcon } from 'lucide-react';
import { cn, hueOf, initials } from '../lib/utils';

// ---------------------------------------------------------------- button

const BUTTON_VARIANTS = {
  primary:
    'bg-brand text-white hover:brightness-110 active:brightness-95 shadow-[0_4px_16px_-6px_rgb(var(--c-brand)/0.8)]',
  secondary: 'bg-elevated text-fg hover:bg-line/60 border border-line',
  ghost: 'text-muted hover:text-fg hover:bg-elevated',
  danger: 'bg-danger text-white hover:brightness-110',
  outline: 'border border-brand/40 text-brand hover:bg-brand/10',
} as const;

const BUTTON_SIZES = {
  sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-lg',
  md: 'h-10 px-4 text-sm gap-2 rounded-xl',
  lg: 'h-12 px-6 text-[15px] gap-2.5 rounded-xl',
  icon: 'h-9 w-9 justify-center rounded-lg',
} as const;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof BUTTON_VARIANTS;
  size?: keyof typeof BUTTON_SIZES;
  loading?: boolean;
  icon?: LucideIcon;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'primary', size = 'md', loading, icon: Icon, children, disabled, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center font-medium transition-all duration-150',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'active:scale-[0.98]',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
      {...props}
    >
      {loading ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> : Icon ? <Icon className="h-4 w-4 shrink-0" /> : null}
      {children}
    </button>
  );
});

// ---------------------------------------------------------------- inputs

const FIELD_BASE =
  'w-full rounded-xl border border-line bg-elevated px-3.5 text-sm text-fg placeholder:text-muted/70 ' +
  'transition-colors focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30 disabled:opacity-60';

export function Label({ children, required, htmlFor }: { children: ReactNode; required?: boolean; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-[13px] font-medium text-muted">
      {children}
      {required ? <span className="text-danger"> *</span> : null}
    </label>
  );
}

export interface FieldProps {
  label?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: ReactNode;
  className?: string;
}

export function Field({ label, hint, error, required, children, className }: FieldProps) {
  return (
    <div className={cn('min-w-0', className)}>
      {label ? <Label required={required}>{label}</Label> : null}
      {children}
      {error ? (
        <p className="mt-1.5 flex items-start gap-1.5 text-[13px] text-danger">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      ) : hint ? (
        <p className="mt-1.5 text-[13px] text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref,
) {
  return <input ref={ref} className={cn(FIELD_BASE, 'h-10', className)} {...props} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return <textarea ref={ref} className={cn(FIELD_BASE, 'min-h-[96px] py-2.5 leading-relaxed', className)} {...props} />;
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...props },
  ref,
) {
  return (
    <div className="relative">
      <select ref={ref} className={cn(FIELD_BASE, 'h-10 appearance-none pe-9', className)} {...props}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
    </div>
  );
});

export function Toggle({
  checked, onChange, label, disabled,
}: { checked: boolean; onChange: (value: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50',
        checked ? 'bg-brand' : 'bg-line',
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform',
          // Uses logical offsets so the knob travels the right way in RTL.
          'start-0.5',
          checked ? 'translate-x-5 rtl:-translate-x-5' : 'translate-x-0',
        )}
      />
    </button>
  );
}

// ---------------------------------------------------------------- surfaces

export function Card({
  className, children, hover, ...props
}: { className?: string; children: ReactNode; hover?: boolean } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        // `min-w-0` matters: as a grid/flex child the default `min-width: auto`
        // stops the card shrinking, which is what pushes the page sideways.
        'card min-w-0',
        hover && 'transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lift hover:border-brand/30',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title, subtitle, action, icon: Icon,
}: { title: ReactNode; subtitle?: ReactNode; action?: ReactNode; icon?: LucideIcon }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        {Icon ? (
          <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand/12 text-brand">
            <Icon className="h-4 w-4" />
          </span>
        ) : null}
        <div className="min-w-0">
          <h3 className="truncate text-[15px] font-semibold text-fg">{title}</h3>
          {subtitle ? <p className="mt-0.5 text-[13px] text-muted">{subtitle}</p> : null}
        </div>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

const BADGE_TONES = {
  neutral: 'bg-elevated text-muted border-line',
  brand: 'bg-brand/12 text-brand border-brand/25',
  ok: 'bg-ok/12 text-ok border-ok/25',
  warn: 'bg-warn/12 text-warn border-warn/25',
  danger: 'bg-danger/12 text-danger border-danger/25',
  accent: 'bg-accent/12 text-accent border-accent/25',
} as const;

export type BadgeTone = keyof typeof BADGE_TONES;

export function Badge({
  children, tone = 'neutral', className, dot,
}: { children: ReactNode; tone?: BadgeTone; className?: string; dot?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide',
        BADGE_TONES[tone],
        className,
      )}
    >
      {dot ? <span className="h-1.5 w-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}

export function Avatar({ name, src, size = 36 }: { name: string; src?: string | null; size?: number }) {
  const hue = hueOf(name);
  if (src) {
    return (
      <img
        src={src}
        alt={name}
        width={size}
        height={size}
        className="shrink-0 rounded-full object-cover ring-1 ring-line"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full font-semibold text-white ring-1 ring-white/10"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.36,
        background: `linear-gradient(135deg, hsl(${hue} 62% 48%), hsl(${(hue + 40) % 360} 62% 38%))`,
      }}
    >
      {initials(name)}
    </span>
  );
}

export function Progress({ value, tone = 'brand' }: { value: number; tone?: 'brand' | 'ok' | 'warn' | 'danger' }) {
  const clamped = Math.max(0, Math.min(1, value));
  const colors = { brand: 'bg-brand', ok: 'bg-ok', warn: 'bg-warn', danger: 'bg-danger' };
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-elevated">
      <motion.div
        className={cn('h-full rounded-full', colors[tone])}
        initial={{ width: 0 }}
        animate={{ width: `${clamped * 100}%` }}
        transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
      />
    </div>
  );
}

// ---------------------------------------------------------------- states

export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={cn('skeleton', className)} style={style} />;
}

export function CardSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <Card className="p-5">
      <Skeleton className="h-4 w-1/3" />
      <div className="mt-4 space-y-2.5">
        {Array.from({ length: rows }).map((_, index) => (
          <Skeleton key={index} className="h-3" style={{ width: `${90 - index * 12}%` }} />
        ))}
      </div>
    </Card>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('h-5 w-5 animate-spin text-muted', className)} />;
}

export function EmptyState({
  icon: Icon, title, body, action, compact,
}: { icon: LucideIcon; title: string; body: string; action?: ReactNode; compact?: boolean }) {
  // `compact` is for an empty panel inside a dashboard column, where the full
  // treatment would be a hole in the page rather than an explanation.
  return (
    <div className={cn('flex flex-col items-center justify-center text-center', compact ? 'px-5 py-10' : 'px-6 py-16')}>
      {compact ? (
        <span className="mb-3 grid h-10 w-10 place-items-center rounded-xl border border-line bg-elevated text-muted">
          <Icon className="h-4 w-4" />
        </span>
      ) : (
        <div className="relative mb-5">
          <span className="absolute inset-0 animate-pulse-ring rounded-2xl bg-brand/20" />
          <span className="relative grid h-14 w-14 place-items-center rounded-2xl border border-brand/25 bg-brand/10 text-brand">
            <Icon className="h-6 w-6" />
          </span>
        </div>
      )}
      <h3 className={cn('font-semibold text-fg', compact ? 'text-[14px]' : 'text-base')}>{title}</h3>
      <p className={cn('mt-1.5 max-w-sm text-muted', compact ? 'text-[12.5px] leading-snug' : 'text-sm')}>{body}</p>
      {action ? <div className={compact ? 'mt-3' : 'mt-5'}>{action}</div> : null}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <span className="mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-danger/12 text-danger">
        <AlertCircle className="h-5 w-5" />
      </span>
      <p className="max-w-sm text-sm text-fg">{message}</p>
      {onRetry ? (
        <Button variant="secondary" size="sm" className="mt-4" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- overlays

export function Modal({
  open, onClose, title, subtitle, children, footer, size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    // Prevent the page behind the modal from scrolling.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  const widths = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl', xl: 'max-w-5xl' };

  return createPortal(
    <AnimatePresence>
      {open ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6">
          <motion.div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={title}
            className={cn(
              'relative flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-2xl border border-line bg-surface shadow-lift sm:rounded-2xl',
              widths[size],
            )}
            initial={{ opacity: 0, y: 24, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.98 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-fg">{title}</h2>
                {subtitle ? <p className="mt-0.5 text-[13px] text-muted">{subtitle}</p> : null}
              </div>
              <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
            {footer ? <div className="flex justify-end gap-2 border-t border-line px-5 py-3.5">{footer}</div> : null}
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}

export function Drawer({
  open, onClose, title, children, footer,
}: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return createPortal(
    <AnimatePresence>
      {open ? (
        <div className="fixed inset-0 z-50">
          <motion.div
            className="absolute inset-0 bg-black/55 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.aside
            className="absolute inset-y-0 end-0 flex w-full max-w-md flex-col border-s border-line bg-surface shadow-lift"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 300 }}
          >
            <div className="flex items-center justify-between border-b border-line px-5 py-4">
              <h2 className="text-base font-semibold">{title}</h2>
              <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
            {footer ? <div className="border-t border-line px-5 py-3.5">{footer}</div> : null}
          </motion.aside>
        </div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}

// ---------------------------------------------------------------- tabs

export function Tabs<T extends string>({
  tabs, value, onChange, className,
}: { tabs: Array<{ value: T; label: string; count?: number }>; value: T; onChange: (value: T) => void; className?: string }) {
  const layoutId = useId();
  return (
    <div className={cn('flex gap-1 overflow-x-auto border-b border-line', className)}>
      {tabs.map((tab) => (
        <button
          key={tab.value}
          onClick={() => onChange(tab.value)}
          className={cn(
            'relative whitespace-nowrap px-3.5 py-2.5 text-sm font-medium transition-colors',
            value === tab.value ? 'text-fg' : 'text-muted hover:text-fg',
          )}
        >
          <span className="flex items-center gap-2">
            {tab.label}
            {tab.count !== undefined ? (
              <span className="rounded-full bg-elevated px-1.5 py-0.5 text-[11px] tabular">{tab.count}</span>
            ) : null}
          </span>
          {value === tab.value ? (
            <motion.span layoutId={layoutId} className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-brand" />
          ) : null}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- toast

type ToastTone = 'success' | 'error' | 'info';
interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  body?: string;
}

const ToastContext = createContext<{ push: (toast: Omit<Toast, 'id'>) => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((toast: Omit<Toast, 'id'>) => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { ...toast, id }]);
    setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), 5200);
  }, []);

  const value = useMemo(() => ({ push }), [push]);
  const icons = { success: Check, error: AlertCircle, info: Info };
  const tones = { success: 'text-ok', error: 'text-danger', info: 'text-brand' };

  return (
    <ToastContext.Provider value={value}>
      {children}
      {createPortal(
        <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4 sm:inset-x-auto sm:end-0 sm:items-end">
          <AnimatePresence initial={false}>
            {toasts.map((toast) => {
              const Icon = icons[toast.tone];
              return (
                <motion.div
                  key={toast.id}
                  layout
                  initial={{ opacity: 0, y: 12, scale: 0.96 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.15 } }}
                  className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border border-line bg-surface p-3.5 shadow-lift"
                >
                  <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', tones[toast.tone])} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-fg">{toast.title}</p>
                    {toast.body ? <p className="mt-0.5 text-[13px] text-muted">{toast.body}</p> : null}
                  </div>
                  <button
                    onClick={() => setToasts((current) => current.filter((item) => item.id !== toast.id))}
                    className="text-muted transition-colors hover:text-fg"
                    aria-label="Dismiss"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside <ToastProvider>');
  return context;
}

// ---------------------------------------------------------------- table

export function TableWrap({ children, className }: { children: ReactNode; className?: string }) {
  // Tables scroll inside their own container so the page never scrolls sideways.
  return (
    <div className={cn('w-full overflow-x-auto', className)}>
      <table className="w-full min-w-[640px] border-collapse text-sm">{children}</table>
    </div>
  );
}

export function Th({ children, align = 'start', className }: { children?: ReactNode; align?: 'start' | 'end'; className?: string }) {
  return (
    <th
      className={cn(
        'whitespace-nowrap border-b border-line px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted',
        align === 'end' ? 'text-end' : 'text-start',
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({ children, align = 'start', className }: { children?: ReactNode; align?: 'start' | 'end'; className?: string }) {
  return (
    <td
      className={cn(
        'border-b border-line/60 px-4 py-3 text-fg',
        align === 'end' ? 'text-end tabular' : 'text-start',
        className,
      )}
    >
      {children}
    </td>
  );
}

// ---------------------------------------------------------------- misc

export function Pagination({
  page, pages, onChange,
}: { page: number; pages: number; onChange: (page: number) => void }) {
  if (pages <= 1) return null;
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <span className="text-[13px] text-muted">
        Page <span className="tabular text-fg">{page}</span> of <span className="tabular text-fg">{pages}</span>
      </span>
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => onChange(page - 1)}>
          Previous
        </Button>
        <Button variant="secondary" size="sm" disabled={page >= pages} onClick={() => onChange(page + 1)}>
          Next
        </Button>
      </div>
    </div>
  );
}

/**
 * The page's identity, pinned under the global header.
 *
 * A long page scrolls its title and its tabs away, and on a screen where the
 * body is mostly one tall card that reads as "the page lost its heading" —
 * which is exactly what it looked like on a content record: scroll down and
 * nothing on screen says which post you are looking at or which tab you are in.
 *
 * One sticky context, not two. Pinning a header and a tab strip separately
 * means computing the second offset from the first's rendered height, which is
 * wrong the moment a title wraps. Wrapping both in a single sticky element
 * makes the browser do that arithmetic.
 *
 * `top-16` is the global header's height, and `z-10` sits under its `z-20`, so
 * this bar tucks beneath it rather than over it. The negative insets are the
 * main element's own padding, so the background reaches the edges and content
 * scrolls under it invisibly rather than appearing beside it.
 */
export function PageBar({ children }: { children: ReactNode }) {
  return (
    <div className="sticky top-16 z-10 -mx-4 mb-4 border-b border-line bg-bg/95 px-4 pt-4 backdrop-blur-sm sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
      {children}
    </div>
  );
}

export function PageHeader({
  title, subtitle, action, children, className,
}: {
  title: string; subtitle?: string; action?: ReactNode; children?: ReactNode;
  /** Spacing only. Inside a `PageBar` the gap below belongs to the bar. */
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-end justify-between gap-4', className ?? 'mb-6')}>
      <div className="min-w-0 flex-1">
        <h1 className="text-[22px] font-semibold tracking-tight text-fg sm:text-2xl">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-muted">{subtitle}</p> : null}
        {children}
      </div>
      {/* Full width on small screens so controls wrap instead of overflowing. */}
      {action ? <div className="flex w-full flex-wrap gap-2 sm:w-auto">{action}</div> : null}
    </div>
  );
}
