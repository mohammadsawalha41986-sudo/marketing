/**
 * Sign in.
 *
 * The only public page in the application. There is no registration and no
 * password-reset form, because neither endpoint exists — this is a private
 * system whose single account is created out of band with `npm run owner:create`.
 */

import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowRight, BarChart3, CalendarCheck, Sparkles, Store } from 'lucide-react';

import { ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { Button, Field, Input, useToast } from '../components/ui';
import { LanguageSwitch, ThemeSwitch } from '../components/layout';

export function LoginPage() {
  const { signIn, user, loading } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();
  const { push } = useToast();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!loading && user) return <Navigate to="/dashboard" replace />;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const next = await signIn(email.trim(), password);
      push({ tone: 'success', title: `Welcome back, ${next.name.split(' ')[0]}` });
      navigate('/dashboard');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative min-h-screen overflow-hidden bg-bg">
      <div className="pointer-events-none absolute inset-0 subtle-grid" aria-hidden />
      <div
        className="pointer-events-none absolute -top-40 start-1/2 h-[32rem] w-[32rem] -translate-x-1/2 rounded-full opacity-25 blur-3xl"
        style={{ background: 'radial-gradient(circle, rgb(var(--c-brand)), transparent 70%)' }}
        aria-hidden
      />

      <div className="absolute end-4 top-4 z-10 flex items-center gap-2">
        <div className="hidden sm:block"><ThemeSwitch /></div>
        <LanguageSwitch />
      </div>

      <div className="relative mx-auto grid min-h-screen w-full max-w-6xl items-center gap-10 px-5 py-10 lg:grid-cols-2 lg:gap-16">
        {/* Pitch panel — hidden on small screens where the form is what matters. */}
        <div className="hidden lg:block">
          <span className="inline-flex items-center gap-2 rounded-full border border-line bg-surface/60 px-3 py-1 text-[13px] text-muted backdrop-blur">
            <Sparkles className="h-3.5 w-3.5 text-brand" />
            {t('app.tagline')}
          </span>
          <h1 className="mt-6 text-5xl font-semibold leading-[1.05] tracking-tight text-fg">
            Every restaurant you market, from{' '}
            <span className="brand-gradient-text">one command centre</span>
          </h1>
          <p className="mt-5 max-w-md text-[15px] leading-relaxed text-muted">
            Brand identity, AI content, campaigns, ads, calendar and reporting — for every restaurant on your
            books, in one place.
          </p>

          <div className="mt-10 space-y-4">
            {[
              { icon: Store, title: 'One workspace, many restaurants', body: 'Open a restaurant and see its brand, content, campaigns, ads and reports together.' },
              { icon: CalendarCheck, title: 'Know what ships next', body: 'A unified calendar across every restaurant, filterable down to one.' },
              { icon: BarChart3, title: 'Numbers you can defend', body: 'Every figure traces to measured data, never an estimate.' },
            ].map((feature, index) => (
              <motion.div
                key={feature.title}
                initial={{ opacity: 0, x: -12 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.1 + index * 0.09 }}
                className="flex gap-3.5"
              >
                <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-brand/25 bg-brand/10 text-brand">
                  <feature.icon className="h-4 w-4" />
                </span>
                <div>
                  <p className="text-sm font-medium text-fg">{feature.title}</p>
                  <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{feature.body}</p>
                </div>
              </motion.div>
            ))}
          </div>
        </div>

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          className="mx-auto w-full max-w-md"
        >
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-brand to-accent text-white">
              <Sparkles className="h-5 w-5" />
            </span>
            <span className="text-lg font-semibold">{t('app.name')}</span>
          </div>

          <div className="card p-6 sm:p-7">
            <h2 className="text-xl font-semibold tracking-tight text-fg">{t('auth.welcome')}</h2>
            <p className="mt-1.5 text-sm text-muted">{t('auth.welcomeSub')}</p>

            <form onSubmit={onSubmit} className="mt-6 space-y-4">
              <Field label={t('auth.email')} required>
                <Input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoComplete="username"
                  required
                  autoFocus
                />
              </Field>
              <Field label={t('auth.password')} required error={error ?? undefined}>
                <Input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                  required
                />
              </Field>
              <Button type="submit" loading={busy} className="w-full" icon={ArrowRight}>
                {t('auth.signIn')}
              </Button>
            </form>
          </div>

          <p className="mt-5 text-center text-[13px] text-muted">{t('auth.privateNotice')}</p>
        </motion.div>
      </div>
    </div>
  );
}
