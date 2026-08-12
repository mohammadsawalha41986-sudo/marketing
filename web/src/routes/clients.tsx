/** Client roster and the per-client profile. */

import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Building2, ExternalLink, Globe, Mail, MapPin, Megaphone, PenLine, Phone, Plus, Search, Trash2,
} from 'lucide-react';

import { api, qs, type Metrics, type Paginated } from '../lib/api';
import { useDebounced, useQuery } from '../lib/hooks';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { money, num, ratio, pct } from '../lib/format';
import {
  Avatar, Badge, Button, Card, CardHeader, CardSkeleton, EmptyState, ErrorState, Field, Input,
  Modal, PageHeader, Pagination, Select, Tabs, Td, Th, TableWrap, Textarea, useToast,
} from '../components/ui';
import { KpiCard, StatusBadge } from '../components/domain';

interface ClientRow {
  id: string;
  name: string;
  businessName: string;
  email: string | null;
  phone: string | null;
  industry: string | null;
  businessType: string | null;
  website: string | null;
  location: string | null;
  status: string;
  logoUrl: string | null;
  brand: { primaryColor: string; accentColor: string; logoUrl: string | null } | null;
  subscription: { status: string; plan: { name: string } } | null;
  _count: { campaigns: number; contents: number; media: number };
}

const STATUSES = ['ACTIVE', 'PAUSED', 'SUSPENDED', 'ARCHIVED'];

function ClientForm({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const { push } = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: '', businessName: '', email: '', phone: '', businessType: '',
    industry: '', website: '', location: '', notes: '', preferredLanguage: 'EN',
  });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/clients', {
        ...form,
        website: form.website.trim() || undefined,
        email: form.email.trim() || undefined,
      });
      push({ tone: 'success', title: 'Client created', body: 'Build its Brand DNA next.' });
      onSaved();
      onClose();
      setForm({ name: '', businessName: '', email: '', phone: '', businessType: '', industry: '', website: '', location: '', notes: '', preferredLanguage: 'EN' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the client');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add a client"
      subtitle="A Brand DNA profile is created automatically so the AI can write in its voice."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button form="client-form" type="submit" loading={busy}>Create client</Button>
        </>
      }
    >
      <form id="client-form" onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <Field label="Client name" required>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required placeholder="Zaytoun Kitchen" />
        </Field>
        <Field label="Legal or trading name" required>
          <Input value={form.businessName} onChange={(e) => setForm({ ...form, businessName: e.target.value })} required />
        </Field>
        <Field label="Business type">
          <Input value={form.businessType} onChange={(e) => setForm({ ...form, businessType: e.target.value })} placeholder="Restaurant, Hotel, Retail…" />
        </Field>
        <Field label="Industry">
          <Input value={form.industry} onChange={(e) => setForm({ ...form, industry: e.target.value })} />
        </Field>
        <Field label="Email">
          <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Field label="Phone">
          <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </Field>
        <Field label="Website" hint="Include https://">
          <Input value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} placeholder="https://" />
        </Field>
        <Field label="Location">
          <Input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
        </Field>
        <Field label="Content language" className="sm:col-span-2">
          <Select value={form.preferredLanguage} onChange={(e) => setForm({ ...form, preferredLanguage: e.target.value })}>
            <option value="EN">English</option>
            <option value="AR">العربية</option>
          </Select>
        </Field>
        <Field label="Notes" className="sm:col-span-2" error={error ?? undefined}>
          <Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={3} />
        </Field>
      </form>
    </Modal>
  );
}

export function ClientsPage() {
  const { t, lang } = useI18n();
  const { canManage } = useAuth();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const debounced = useDebounced(search);

  const { data, loading, error, refetch } = useQuery<Paginated<ClientRow>>(
    `/clients${qs({ page, pageSize: 12, search: debounced, status })}`,
    [page, debounced, status],
  );

  return (
    <>
      <PageHeader
        title={t('nav.clients')}
        subtitle="Every brand you manage, with its own data, brand identity and portal."
        action={canManage ? <Button icon={Plus} onClick={() => setCreating(true)}>Add client</Button> : undefined}
      />

      <div className="mb-4 flex flex-wrap gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <Input
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            placeholder={t('common.search')}
            className="ps-9"
          />
        </div>
        <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="w-44">
          <option value="">{t('common.all')}</option>
          {STATUSES.map((value) => <option key={value} value={value}>{value.toLowerCase()}</option>)}
        </Select>
      </div>

      {error ? (
        <Card><ErrorState message={error} onRetry={refetch} /></Card>
      ) : loading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => <CardSkeleton key={index} />)}
        </div>
      ) : data && data.items.length > 0 ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {data.items.map((client) => (
              <Card
                key={client.id}
                hover
                className="cursor-pointer overflow-hidden"
                onClick={() => navigate(`/app/clients/${client.id}`)}
              >
                <span
                  className="block h-1"
                  style={{
                    background: client.brand
                      ? `linear-gradient(90deg, ${client.brand.primaryColor}, ${client.brand.accentColor})`
                      : 'rgb(var(--c-line))',
                  }}
                />
                <div className="p-5">
                  <div className="flex items-start gap-3">
                    <Avatar name={client.businessName} src={client.logoUrl} size={44} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold text-fg">{client.name}</p>
                      <p className="truncate text-[13px] text-muted">
                        {client.businessType ?? '—'}{client.industry ? ` · ${client.industry}` : ''}
                      </p>
                    </div>
                    <StatusBadge status={client.status} kind="campaign" />
                  </div>

                  {client.location ? (
                    <p className="mt-3 flex items-center gap-1.5 text-[13px] text-muted">
                      <MapPin className="h-3.5 w-3.5" /> {client.location}
                    </p>
                  ) : null}

                  <div className="mt-4 grid grid-cols-3 gap-2 border-t border-line pt-3.5 text-center">
                    {[
                      { label: t('nav.campaigns'), value: client._count.campaigns },
                      { label: t('nav.content'), value: client._count.contents },
                      { label: t('nav.media'), value: client._count.media },
                    ].map((stat) => (
                      <div key={stat.label}>
                        <p className="tabular text-lg font-semibold text-fg">{num(stat.value, lang)}</p>
                        <p className="text-[11px] uppercase tracking-wide text-muted">{stat.label}</p>
                      </div>
                    ))}
                  </div>

                  {client.subscription ? (
                    <Badge tone="brand" className="mt-3">{client.subscription.plan.name}</Badge>
                  ) : null}
                </div>
              </Card>
            ))}
          </div>
          <Card className="mt-4">
            <Pagination page={data.pagination.page} pages={data.pagination.pages} onChange={setPage} />
          </Card>
        </>
      ) : (
        <Card>
          <EmptyState
            icon={Building2}
            title={debounced ? t('empty.search.title') : t('empty.clients.title')}
            body={debounced ? t('empty.search.body') : t('empty.clients.body')}
            action={canManage && !debounced ? <Button icon={Plus} onClick={() => setCreating(true)}>Add client</Button> : undefined}
          />
        </Card>
      )}

      <ClientForm open={creating} onClose={() => setCreating(false)} onSaved={refetch} />
    </>
  );
}

// ---------------------------------------------------------------- detail

interface ClientDetail extends ClientRow {
  notes: string | null;
  socialLinks: Record<string, string>;
  brand: (ClientRow['brand'] & { id: string; businessName: string; description: string | null }) | null;
  users: Array<{ id: string; name: string; email: string; role: string; isActive: boolean }>;
  integrations: Array<{ id: string; platform: string; status: string; accountName: string | null }>;
  _count: { campaigns: number; contents: number; media: number; reports: number };
}

interface Overview {
  metrics: Metrics;
  campaignsByStatus: Record<string, number>;
  pendingApprovals: number;
  scheduled: number;
  recentContent: Array<{ id: string; name: string; status: string; platform: string; updatedAt: string }>;
  window: { from: string; to: string };
}

export function ClientDetailPage() {
  const { id = '' } = useParams();
  const { t, lang } = useI18n();
  const { canManage } = useAuth();
  const navigate = useNavigate();
  const { push } = useToast();
  const [tab, setTab] = useState<'overview' | 'users' | 'settings'>('overview');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const { data, loading, error, refetch } = useQuery<{ client: ClientDetail }>(`/clients/${id}`, [id]);
  const overview = useQuery<Overview>(`/clients/${id}/overview`, [id]);

  const remove = async () => {
    try {
      await api.delete(`/clients/${id}`);
      push({ tone: 'success', title: 'Client deleted' });
      navigate('/app/clients');
    } catch (err) {
      push({ tone: 'error', title: 'Could not delete', body: err instanceof Error ? err.message : undefined });
    }
  };

  if (loading) return <div className="space-y-4"><CardSkeleton rows={2} /><CardSkeleton rows={4} /></div>;
  if (error || !data) return <Card><ErrorState message={error ?? 'Client not found'} onRetry={refetch} /></Card>;

  const client = data.client;
  const metrics = overview.data?.metrics;

  return (
    <>
      <PageHeader
        title={client.name}
        subtitle={[client.businessType, client.industry, client.location].filter(Boolean).join(' · ')}
        action={
          <>
            <Button variant="secondary" onClick={() => navigate(`/app/brand?client=${client.id}`)}>Brand DNA</Button>
            <Button onClick={() => navigate(`/app/studio?client=${client.id}`)} icon={PenLine}>Create content</Button>
          </>
        }
      />

      <Card className="mb-4 overflow-hidden">
        <span
          className="block h-1.5"
          style={{
            background: client.brand
              ? `linear-gradient(90deg, ${client.brand.primaryColor}, ${client.brand.accentColor})`
              : 'rgb(var(--c-line))',
          }}
        />
        <div className="flex flex-wrap items-center gap-4 p-5">
          <Avatar name={client.businessName} src={client.logoUrl} size={56} />
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-fg">{client.businessName}</p>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-muted">
              {client.email ? <span className="flex items-center gap-1.5"><Mail className="h-3.5 w-3.5" />{client.email}</span> : null}
              {client.phone ? <span className="flex items-center gap-1.5"><Phone className="h-3.5 w-3.5" />{client.phone}</span> : null}
              {client.website ? (
                <a href={client.website} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 hover:text-brand">
                  <Globe className="h-3.5 w-3.5" />Website<ExternalLink className="h-3 w-3" />
                </a>
              ) : null}
            </div>
          </div>
          <StatusBadge status={client.status} kind="campaign" />
        </div>
      </Card>

      <Tabs
        className="mb-4"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'overview', label: t('nav.overview') },
          { value: 'users', label: t('nav.users'), count: client.users.length },
          { value: 'settings', label: t('nav.settings') },
        ]}
      />

      {tab === 'overview' ? (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            {overview.loading || !metrics ? (
              Array.from({ length: 4 }).map((_, index) => <CardSkeleton key={index} rows={1} />)
            ) : (
              <>
                <KpiCard label={t('kpi.spend')} value={metrics.spend} format="money" compact />
                <KpiCard label={t('kpi.reach')} value={metrics.reach} compact />
                <KpiCard label={t('kpi.conversions')} value={metrics.conversions} />
                <KpiCard label={t('kpi.roas')} value={metrics.roas} format="ratio" />
              </>
            )}
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader title="Recent content" icon={PenLine} action={<Link to={`/app/content?client=${client.id}`} className="text-[13px] text-brand hover:underline">{t('common.viewAll')}</Link>} />
              <div className="divide-y divide-line/60">
                {overview.data?.recentContent.length ? (
                  overview.data.recentContent.map((item) => (
                    <Link key={item.id} to={`/app/content/${item.id}`} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-elevated">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-medium text-fg">{item.name}</p>
                        <p className="text-[12px] text-muted">{item.platform.replace('_', ' ').toLowerCase()}</p>
                      </div>
                      <StatusBadge status={item.status} kind="content" />
                    </Link>
                  ))
                ) : (
                  <EmptyState icon={PenLine} title={t('empty.content.title')} body={t('empty.content.body')} />
                )}
              </div>
            </Card>

            <Card>
              <CardHeader title="At a glance" icon={Megaphone} />
              <div className="space-y-3 p-4 text-[13px]">
                {[
                  { label: t('nav.campaigns'), value: num(client._count.campaigns, lang) },
                  { label: t('nav.content'), value: num(client._count.contents, lang) },
                  { label: t('nav.media'), value: num(client._count.media, lang) },
                  { label: t('nav.reports'), value: num(client._count.reports, lang) },
                  { label: t('kpi.pending'), value: num(overview.data?.pendingApprovals ?? 0, lang) },
                  { label: t('kpi.scheduled'), value: num(overview.data?.scheduled ?? 0, lang) },
                  { label: t('kpi.ctr'), value: metrics ? pct(metrics.ctr) : '—' },
                  { label: t('kpi.cpc'), value: metrics ? money(metrics.cpc, lang) : '—' },
                  { label: t('kpi.revenue'), value: metrics ? money(metrics.revenue, lang, true) : '—' },
                  { label: t('kpi.roas'), value: metrics ? ratio(metrics.roas) : '—' },
                ].map((row) => (
                  <div key={row.label} className="flex items-center justify-between gap-3">
                    <span className="text-muted">{row.label}</span>
                    <span className="tabular font-medium text-fg">{row.value}</span>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </>
      ) : null}

      {tab === 'users' ? (
        <Card>
          <CardHeader title="Portal users" subtitle="These accounts can sign in and see only this client." />
          <TableWrap>
            <thead>
              <tr><Th>Name</Th><Th>Email</Th><Th>Role</Th><Th>Status</Th></tr>
            </thead>
            <tbody>
              {client.users.length === 0 ? (
                <tr><Td className="text-muted">No portal users yet.</Td><Td /><Td /><Td /></tr>
              ) : (
                client.users.map((user) => (
                  <tr key={user.id}>
                    <Td><span className="flex items-center gap-2"><Avatar name={user.name} size={26} />{user.name}</span></Td>
                    <Td className="text-muted">{user.email}</Td>
                    <Td><Badge>{user.role.replace(/_/g, ' ').toLowerCase()}</Badge></Td>
                    <Td><Badge tone={user.isActive ? 'ok' : 'neutral'}>{user.isActive ? 'active' : 'disabled'}</Badge></Td>
                  </tr>
                ))
              )}
            </tbody>
          </TableWrap>
        </Card>
      ) : null}

      {tab === 'settings' ? (
        <Card>
          <CardHeader title="Client settings" />
          <div className="space-y-4 p-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Notes"><Textarea readOnly value={client.notes ?? ''} rows={4} /></Field>
              <div>
                <Field label="Connected accounts">
                  <div className="space-y-2">
                    {client.integrations.map((integration) => (
                      <div key={integration.id} className="flex items-center justify-between rounded-lg border border-line bg-elevated px-3 py-2 text-[13px]">
                        <span>{integration.platform.replace('_', ' ').toLowerCase()}</span>
                        <Badge tone={integration.status === 'CONNECTED' ? 'ok' : 'neutral'}>
                          {integration.status.toLowerCase()}
                        </Badge>
                      </div>
                    ))}
                  </div>
                </Field>
              </div>
            </div>

            {canManage ? (
              <div className="flex items-center justify-between rounded-xl border border-danger/25 bg-danger/[0.06] p-4">
                <div>
                  <p className="text-sm font-medium text-fg">Delete this client</p>
                  <p className="text-[13px] text-muted">Removes its campaigns, content, media and analytics. This cannot be undone.</p>
                </div>
                <Button variant="danger" icon={Trash2} onClick={() => setConfirmDelete(true)}>Delete</Button>
              </div>
            ) : null}
          </div>
        </Card>
      ) : null}

      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete ${client.name}?`}
        subtitle="Everything belonging to this client is removed permanently."
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button variant="danger" onClick={remove}>Delete client</Button>
          </>
        }
      >
        <p className="text-sm text-muted">
          {client._count.campaigns} campaigns, {client._count.contents} content items and {client._count.media} media
          files will be deleted.
        </p>
      </Modal>
    </>
  );
}
