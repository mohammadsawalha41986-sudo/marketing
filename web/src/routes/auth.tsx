/** Sign in, registration and password reset. */

import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowRight, BarChart3, Bot, CalendarCheck, Sparkles } from 'lucide-react';

import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { Button, Field, Input, useToast } from '../components/ui';
import { LanguageSwitch, ThemeSwitch } from '../components/layout';

function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle: string; children: ReactNode; footer: ReactNode }) {
  const { t } = useI18n();

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
            Run every brand from{' '}
            <span className="brand-gradient-text">one command centre</span>
          </h1>
          <p className="mt-5 max-w-md text-[15px] leading-relaxed text-muted">
            Brand DNA, AI content, campaign scheduling, client approvals and reporting — for every client you manage,
            in one place.
          </p>

          <div className="mt-10 space-y-4">
            {[
              { icon: Bot, title: 'AI that knows the brand', body: 'Copy and hashtags written from each client’s Brand DNA, in Arabic or English.' },
              { icon: CalendarCheck, title: 'Approvals before anything ships', body: 'Clients review in their own portal. Nothing schedules without sign-off.' },
              { icon: BarChart3, title: 'Numbers you can defend', body: 'Every figure traces to measured campaign data, never an estimate.' },
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
            <span className="text-lg font-semibold">Marketing OS</span>
          </div>

          <div className="card p-6 sm:p-7">
            <h2 className="text-xl font-semibold tracking-tight text-fg">{title}</h2>
            <p className="mt-1.5 text-sm text-muted">{subtitle}</p>
            <div className="mt-6">{children}</div>
          </div>

          <div className="mt-5 text-center text-[13px] text-muted">{footer}</div>
        </motion.div>
      </div>
    </div>
  );
}

export function LoginPage() {
  const { signIn, user, loading } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();
  const { push } = useToast();

  const [email, setEmail] = useState('admin@northwind.example.com');
  const [password, setPassword] = useState('Passw0rd!demo');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!loading && user) {
    return <Navigate to={user.role === 'CLIENT_ADMIN' || user.role === 'CLIENT_USER' ? '/client/dashboard' : '/app/dashboard'} replace />;
  }

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const next = await signIn(email.trim(), password);
      push({ tone: 'success', title: `Welcome back, ${next.name.split(' ')[0]}` });
      navigate(next.role === 'CLIENT_ADMIN' || next.role === 'CLIENT_USER' ? '/client/dashboard' : '/app/dashboard');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title={t('auth.welcome')}
      subtitle={t('auth.welcomeSub')}
      footer={
        <>
          {t('auth.noAccount')}{' '}
          <Link to="/register" className="font-medium text-brand hover:underline">{t('auth.register')}</Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label={t('auth.email')} required>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" placeholder="you@agency.com" />
        </Field>
        <Field label={t('auth.password')} required error={error ?? undefined}>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" placeholder="••••••••" />
        </Field>

        <div className="flex justify-end">
          <Link to="/forgot-password" className="text-[13px] text-muted hover:text-brand">{t('auth.forgot')}</Link>
        </div>

        <Button type="submit" className="w-full" size="lg" loading={busy}>
          {t('auth.signIn')} <ArrowRight className="h-4 w-4 rtl:rotate-180" />
        </Button>
      </form>

      <div className="mt-5 rounded-xl border border-dashed border-line bg-elevated/60 p-3 text-[12px] leading-relaxed text-muted">
        <p className="font-medium text-fg">Demo accounts</p>
        <p className="mt-1">Agency admin · admin@northwind.example.com</p>
        <p>Client portal · owner@zaytoun.example.com</p>
        <p>Super admin · root@marketingos.example.com</p>
        <p className="mt-1">Password for all: <code className="rounded bg-surface px-1">Passw0rd!demo</code></p>
      </div>
    </AuthLayout>
  );
}

export function RegisterPage() {
  const { register, user, loading } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();
  const { push } = useToast();

  const [form, setForm] = useState({ name: '', email: '', password: '', organizationName: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  if (!loading && user) return <Navigate to="/app/dashboard" replace />;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      await register({
        name: form.name.trim(),
        email: form.email.trim(),
        password: form.password,
        organizationName: form.organizationName.trim() || undefined,
      });
      push({ tone: 'success', title: 'Workspace created', body: 'Add your first client to get going.' });
      navigate('/app/dashboard');
    } catch (err) {
      if (err instanceof ApiError) {
        const fields: Record<string, string> = {};
        for (const issue of err.fieldErrors) fields[issue.path] = issue.message;
        setErrors(Object.keys(fields).length > 0 ? fields : { form: err.message });
      } else {
        setErrors({ form: 'Could not create the account' });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title={t('auth.register')}
      subtitle={t('auth.registerSub')}
      footer={
        <>
          {t('auth.haveAccount')}{' '}
          <Link to="/login" className="font-medium text-brand hover:underline">{t('auth.signIn')}</Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label={t('auth.name')} required error={errors.name}>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required autoComplete="name" />
        </Field>
        <Field label={t('auth.orgName')} error={errors.organizationName} hint="Leave blank and we will name it after you.">
          <Input value={form.organizationName} onChange={(e) => setForm({ ...form, organizationName: e.target.value })} autoComplete="organization" />
        </Field>
        <Field label={t('auth.email')} required error={errors.email}>
          <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required autoComplete="email" />
        </Field>
        <Field
          label={t('auth.password')}
          required
          error={errors.password ?? errors.form}
          hint="At least 10 characters, with upper case, lower case and a digit."
        >
          <Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required autoComplete="new-password" />
        </Field>

        <Button type="submit" className="w-full" size="lg" loading={busy}>
          {t('auth.register')} <ArrowRight className="h-4 w-4 rtl:rotate-180" />
        </Button>
      </form>
    </AuthLayout>
  );
}

export function ForgotPasswordPage() {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [devToken, setDevToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const response = await api.post<{ message: string; devToken?: string }>('/auth/forgot-password', {
        email: email.trim(),
      });
      setSent(response.message);
      setDevToken(response.devToken ?? null);
    } catch {
      setSent('If that email is registered, a reset link has been issued.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title={t('auth.resetTitle')}
      subtitle={t('auth.resetSub')}
      footer={<Link to="/login" className="font-medium text-brand hover:underline">{t('auth.backToSignIn')}</Link>}
    >
      {sent ? (
        <div className="space-y-3">
          <p className="rounded-xl border border-ok/25 bg-ok/10 p-3.5 text-[13px] text-ok">{sent}</p>
          {devToken ? (
            <div className="rounded-xl border border-dashed border-line bg-elevated p-3 text-[12px] text-muted">
              <p className="font-medium text-fg">Development mode</p>
              <p className="mt-1">
                No mail transport is configured, so the token is shown here instead of emailed:
              </p>
              <code className="mt-1.5 block break-all rounded bg-surface p-2 text-[11px]">{devToken}</code>
            </div>
          ) : null}
        </div>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4">
          <Field label={t('auth.email')} required>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
          </Field>
          <Button type="submit" className="w-full" size="lg" loading={busy}>
            {t('auth.sendReset')}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
