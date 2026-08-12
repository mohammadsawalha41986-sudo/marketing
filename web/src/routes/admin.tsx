/** Super Admin: platform overview, tenants, users, plans, subscriptions, audit. */

import { useState } from 'react';
import {
  Activity, Building2, CreditCard, Database, HardDrive, Search, Server, Shield, Users,
} from 'lucide-react';

import { api, qs, type Paginated } from '../lib/api';
import { useDebounced, useQuery } from '../lib/hooks';
import { useI18n } from '../lib/i18n';
import { date, dateTime, humanize, money, num } from '../lib/format';
import {
  Badge, Button, Card, CardHeader, CardSkeleton, EmptyState, ErrorState, Field, Input, Modal,
  PageHeader, Pagination, Select, TableWrap, Td, Th, useToast,
} from '../components/ui';
import { KpiCard } from '../components/domain';

export function AdminDashboardPage() {
  const { t, lang } = useI18n();
  const { data, loading, error, refetch } = useQuery<{
    platform: {
      organizations: number; users: number; clients: Record<string, number>;
      campaigns: Record<string, number>; contents: number; mediaCount: number;
      storageMb: number; subscriptions: Record<string, number>;
    };
    metrics30d: { spend: number; revenue: number; conversions: number; roas: number; impressions: number };
    ai: { provider: string; model: string; configured: boolean; thisMonth: Record<string, number> };
    recentActivity: Array<{ id: string; action: string; entity: string; createdAt: string; user: { name: string } | null; organization: { name: string } | null }>;
  }>('/admin/dashboard');

  if (error) return <><PageHeader title={t('nav.admin')} /><Card><ErrorState message={error} onRetry={refetch} /></Card></>;

  const totalClients = Object.values(data?.platform.clients ?? {}).reduce((sum, value) => sum + value, 0);

  return (
    <>
      <PageHeader
        title="Platform overview"
        subtitle="Everything across every tenant. This is the only view that reads across organizations."
        action={<Badge tone="danger" dot>Super Admin</Badge>}
      />

      {loading ? (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, index) => <CardSkeleton key={index} rows={1} />)}
        </div>
      ) : data ? (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            <KpiCard label="Organizations" value={data.platform.organizations} icon={Building2} />
            <KpiCard label="Users" value={data.platform.users} icon={Users} />
            <KpiCard label="Clients" value={totalClients} icon={Building2} />
            <KpiCard label="Content items" value={data.platform.contents} icon={Activity} />
          </div>

          <div className="mb-4 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            <KpiCard label="Spend (30d)" value={data.metrics30d.spend} format="money" compact />
            <KpiCard label="Revenue (30d)" value={data.metrics30d.revenue} format="money" compact />
            <KpiCard label="Conversions (30d)" value={data.metrics30d.conversions} />
            <KpiCard label="Blended ROAS" value={data.metrics30d.roas} format="ratio" />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card>
              <CardHeader title="Storage and media" icon={HardDrive} />
              <div className="space-y-3 p-5 text-[13px]">
                <div className="flex justify-between"><span className="text-muted">Files</span><span className="tabular text-fg">{num(data.platform.mediaCount, lang)}</span></div>
                <div className="flex justify-between"><span className="text-muted">Total size</span><span className="tabular text-fg">{data.platform.storageMb} MB</span></div>
                <div className="flex justify-between"><span className="text-muted">Impressions (30d)</span><span className="tabular text-fg">{num(data.metrics30d.impressions, lang, true)}</span></div>
              </div>
            </Card>

            <Card>
              <CardHeader title="AI usage this month" icon={Server} />
              <div className="space-y-3 p-5 text-[13px]">
                <div className="flex items-center justify-between">
                  <span className="text-muted">Provider</span>
                  <Badge tone={data.ai.configured ? 'ok' : 'warn'}>{data.ai.provider}</Badge>
                </div>
                <div className="flex justify-between"><span className="text-muted">Model</span><span className="text-fg">{data.ai.model}</span></div>
                {Object.entries(data.ai.thisMonth).map(([provider, count]) => (
                  <div key={provider} className="flex justify-between">
                    <span className="text-muted">{provider} calls</span>
                    <span className="tabular text-fg">{num(count, lang)}</span>
                  </div>
                ))}
                {Object.keys(data.ai.thisMonth).length === 0 ? <p className="text-muted">No AI calls yet this month.</p> : null}
              </div>
            </Card>

            <Card>
              <CardHeader title="Subscriptions" icon={CreditCard} />
              <div className="space-y-3 p-5 text-[13px]">
                {Object.entries(data.platform.subscriptions).map(([status, count]) => (
                  <div key={status} className="flex justify-between">
                    <span className="text-muted">{humanize(status)}</span>
                    <span className="tabular text-fg">{num(count, lang)}</span>
                  </div>
                ))}
                <p className="border-t border-line pt-2.5 text-[12px] text-muted">
                  No payment provider is connected. Nothing has been charged.
                </p>
              </div>
            </Card>
          </div>

          <Card className="mt-4">
            <CardHeader title="Recent platform activity" icon={Activity} />
            <TableWrap>
              <thead><tr><Th>Action</Th><Th>Entity</Th><Th>User</Th><Th>Organization</Th><Th align="end">When</Th></tr></thead>
              <tbody>
                {data.recentActivity.map((entry) => (
                  <tr key={entry.id}>
                    <Td><Badge>{entry.action}</Badge></Td>
                    <Td className="text-muted">{entry.entity}</Td>
                    <Td>{entry.user?.name ?? 'System'}</Td>
                    <Td className="text-muted">{entry.organization?.name ?? '—'}</Td>
                    <Td align="end" className="text-muted">{dateTime(entry.createdAt, lang)}</Td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          </Card>
        </>
      ) : null}
    </>
  );
}

export function AdminClientsPage() {
  const { lang } = useI18n();
  const { push } = useToast();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const debounced = useDebounced(search);

  const { data, loading, refetch } = useQuery<Paginated<{
    id: string; name: string; businessName: string; status: string; createdAt: string;
    organization: { id: string; name: string };
    subscription: { status: string; plan: { name: string } } | null;
    _count: { campaigns: number; contents: number; users: number };
  }>>(`/admin/clients${qs({ page, pageSize: 20, search: debounced, status })}`, [page, debounced, status]);

  const setClientStatus = async (id: string, next: string) => {
    try {
      await api.post(`/admin/clients/${id}/status`, { status: next });
      push({
        tone: 'success',
        title: `Client ${next.toLowerCase()}`,
        body: next === 'SUSPENDED' ? 'Its users have been signed out.' : undefined,
      });
      refetch();
    } catch (err) {
      push({ tone: 'error', title: 'Could not update', body: err instanceof Error ? err.message : undefined });
    }
  };

  return (
    <>
      <PageHeader title="All clients" subtitle="Every client across every organization." />

      <div className="mb-4 flex flex-wrap gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <Input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="Search clients" className="ps-9" />
        </div>
        <Select value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }} className="w-44">
          <option value="">All statuses</option>
          {['ACTIVE', 'PAUSED', 'SUSPENDED', 'ARCHIVED'].map((value) => <option key={value} value={value}>{humanize(value)}</option>)}
        </Select>
      </div>

      {loading ? <CardSkeleton rows={8} /> : data && data.items.length > 0 ? (
        <Card>
          <TableWrap>
            <thead>
              <tr><Th>Client</Th><Th>Organization</Th><Th>Plan</Th><Th align="end">Campaigns</Th><Th align="end">Users</Th><Th>Status</Th><Th align="end">Actions</Th></tr>
            </thead>
            <tbody>
              {data.items.map((client) => (
                <tr key={client.id}>
                  <Td>
                    <span className="block font-medium">{client.name}</span>
                    <span className="block text-[12px] text-muted">{client.businessName}</span>
                  </Td>
                  <Td className="text-muted">{client.organization.name}</Td>
                  <Td>{client.subscription ? <Badge tone="brand">{client.subscription.plan.name}</Badge> : <span className="text-muted">—</span>}</Td>
                  <Td align="end">{num(client._count.campaigns, lang)}</Td>
                  <Td align="end">{num(client._count.users, lang)}</Td>
                  <Td><Badge tone={client.status === 'ACTIVE' ? 'ok' : client.status === 'SUSPENDED' ? 'danger' : 'neutral'} dot>{client.status.toLowerCase()}</Badge></Td>
                  <Td align="end">
                    <Select
                      value={client.status}
                      onChange={(event) => setClientStatus(client.id, event.target.value)}
                      className="h-8 w-36 text-[13px]"
                    >
                      {['ACTIVE', 'PAUSED', 'SUSPENDED', 'ARCHIVED'].map((value) => (
                        <option key={value} value={value}>{humanize(value)}</option>
                      ))}
                    </Select>
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
          <Pagination page={data.pagination.page} pages={data.pagination.pages} onChange={setPage} />
        </Card>
      ) : (
        <Card><EmptyState icon={Building2} title="No clients" body="No client matches this filter." /></Card>
      )}
    </>
  );
}

export function AdminUsersPage() {
  const { lang } = useI18n();
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('');
  const [page, setPage] = useState(1);
  const debounced = useDebounced(search);

  const { data, loading } = useQuery<Paginated<{
    id: string; name: string; email: string; role: string; isActive: boolean;
    lastLoginAt: string | null; createdAt: string;
    organization: { name: string } | null; client: { name: string } | null;
  }>>(`/admin/users${qs({ page, pageSize: 20, search: debounced, role })}`, [page, debounced, role]);

  return (
    <>
      <PageHeader title="All users" subtitle="Every account on the platform, across all tenants." />

      <div className="mb-4 flex flex-wrap gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <Input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="Search by name or email" className="ps-9" />
        </div>
        <Select value={role} onChange={(event) => { setRole(event.target.value); setPage(1); }} className="w-48">
          <option value="">All roles</option>
          {['SUPER_ADMIN', 'AGENCY_ADMIN', 'AGENCY_STAFF', 'CLIENT_ADMIN', 'CLIENT_USER'].map((value) => (
            <option key={value} value={value}>{humanize(value)}</option>
          ))}
        </Select>
      </div>

      {loading ? <CardSkeleton rows={8} /> : data ? (
        <Card>
          <TableWrap>
            <thead><tr><Th>User</Th><Th>Role</Th><Th>Organization</Th><Th>Client</Th><Th>Last login</Th><Th>Status</Th></tr></thead>
            <tbody>
              {data.items.map((user) => (
                <tr key={user.id}>
                  <Td>
                    <span className="block font-medium">{user.name}</span>
                    <span className="block text-[12px] text-muted">{user.email}</span>
                  </Td>
                  <Td><Badge tone={user.role === 'SUPER_ADMIN' ? 'danger' : 'neutral'}>{humanize(user.role)}</Badge></Td>
                  <Td className="text-muted">{user.organization?.name ?? '—'}</Td>
                  <Td className="text-muted">{user.client?.name ?? '—'}</Td>
                  <Td className="text-muted">{user.lastLoginAt ? date(user.lastLoginAt, lang) : 'Never'}</Td>
                  <Td><Badge tone={user.isActive ? 'ok' : 'neutral'}>{user.isActive ? 'active' : 'disabled'}</Badge></Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
          <Pagination page={data.pagination.page} pages={data.pagination.pages} onChange={setPage} />
        </Card>
      ) : null}
    </>
  );
}

export function AdminPlansPage() {
  const { lang } = useI18n();
  const { push } = useToast();
  const [editing, setEditing] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);

  const { data, loading, refetch } = useQuery<{
    plans: Array<{
      id: string; key: string; name: string; description: string | null;
      priceMonthly: number; priceYearly: number; maxClients: number; maxUsers: number;
      maxCampaigns: number; maxAiPerMonth: number; maxStorageMb: number; maxIntegrations: number;
      features: string[]; isActive: boolean; _count: { subscriptions: number };
    }>;
  }>('/admin/plans');

  const save = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      const { id, _count: _ignored, ...payload } = editing as { id: string; _count?: unknown };
      await api.patch(`/admin/plans/${id}`, payload as Record<string, unknown>);
      push({ tone: 'success', title: 'Plan updated' });
      setEditing(null);
      refetch();
    } catch (err) {
      push({ tone: 'error', title: 'Could not save', body: err instanceof Error ? err.message : undefined });
    } finally {
      setBusy(false);
    }
  };

  const limit = (value: number) => (value === -1 ? 'Unlimited' : num(value, lang));

  return (
    <>
      <PageHeader title="Plans" subtitle="Limits are enforced by the application. Pricing is stored, not charged." />

      {loading ? <CardSkeleton rows={6} /> : data ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {data.plans.map((plan) => (
            <Card key={plan.id} className="flex flex-col p-5">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-semibold text-fg">{plan.name}</p>
                  <p className="text-[12px] text-muted">{plan.key}</p>
                </div>
                <Badge tone={plan.isActive ? 'ok' : 'neutral'}>{plan.isActive ? 'active' : 'hidden'}</Badge>
              </div>

              <p className="mt-3 text-2xl font-semibold text-fg">
                {money(plan.priceMonthly, lang)}<span className="text-[13px] font-normal text-muted">/mo</span>
              </p>
              <p className="mt-1 text-[13px] text-muted">{plan.description}</p>

              <div className="mt-4 flex-1 space-y-1.5 text-[13px]">
                {[
                  ['Clients', plan.maxClients], ['Users', plan.maxUsers], ['Campaigns', plan.maxCampaigns],
                  ['AI / month', plan.maxAiPerMonth], ['Storage MB', plan.maxStorageMb], ['Integrations', plan.maxIntegrations],
                ].map(([label, value]) => (
                  <div key={String(label)} className="flex justify-between">
                    <span className="text-muted">{label}</span>
                    <span className="tabular text-fg">{limit(Number(value))}</span>
                  </div>
                ))}
              </div>

              <div className="mt-4 flex items-center justify-between border-t border-line pt-3">
                <span className="text-[12px] text-muted">{plan._count.subscriptions} subscribers</span>
                <Button size="sm" variant="secondary" onClick={() => setEditing({ ...plan })}>Edit</Button>
              </div>
            </Card>
          ))}
        </div>
      ) : null}

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={`Edit ${(editing?.name as string) ?? ''}`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
            <Button onClick={save} loading={busy}>Save plan</Button>
          </>
        }
      >
        {editing ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" className="sm:col-span-2">
              <Input value={String(editing.name)} onChange={(event) => setEditing({ ...editing, name: event.target.value })} />
            </Field>
            {[
              ['priceMonthly', 'Monthly price'], ['priceYearly', 'Yearly price'],
              ['maxClients', 'Max clients'], ['maxUsers', 'Max users'],
              ['maxCampaigns', 'Max campaigns'], ['maxAiPerMonth', 'AI per month'],
              ['maxStorageMb', 'Storage MB'], ['maxIntegrations', 'Max integrations'],
            ].map(([key, label]) => (
              <Field key={key} label={label} hint={key.startsWith('max') ? '-1 for unlimited' : undefined}>
                <Input
                  type="number"
                  value={Number(editing[key])}
                  onChange={(event) => setEditing({ ...editing, [key]: Number(event.target.value) })}
                />
              </Field>
            ))}
          </div>
        ) : null}
      </Modal>
    </>
  );
}

export function AdminSubscriptionsPage() {
  const { lang } = useI18n();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');

  const { data, loading } = useQuery<Paginated<{
    id: string; status: string; startDate: string; renewalDate: string; providerRef: string | null;
    plan: { name: string; priceMonthly: string };
    organization: { name: string };
    client: { name: string } | null;
  }>>(`/admin/subscriptions${qs({ page, pageSize: 20, status })}`, [page, status]);

  return (
    <>
      <PageHeader
        title="Subscriptions"
        subtitle="Architecture is complete; no payment provider is connected, so nothing has been charged."
        action={
          <Select value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }} className="w-44">
            <option value="">All statuses</option>
            {['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELLED', 'EXPIRED'].map((value) => (
              <option key={value} value={value}>{humanize(value)}</option>
            ))}
          </Select>
        }
      />

      {loading ? <CardSkeleton rows={8} /> : data && data.items.length > 0 ? (
        <Card>
          <TableWrap>
            <thead><tr><Th>Organization</Th><Th>Client</Th><Th>Plan</Th><Th>Status</Th><Th>Started</Th><Th>Renews</Th><Th>Billing</Th></tr></thead>
            <tbody>
              {data.items.map((subscription) => (
                <tr key={subscription.id}>
                  <Td>{subscription.organization.name}</Td>
                  <Td className="text-muted">{subscription.client?.name ?? 'Workspace-wide'}</Td>
                  <Td><Badge tone="brand">{subscription.plan.name}</Badge></Td>
                  <Td><Badge tone={subscription.status === 'ACTIVE' ? 'ok' : subscription.status === 'TRIALING' ? 'brand' : 'neutral'} dot>{subscription.status.toLowerCase()}</Badge></Td>
                  <Td className="text-muted">{date(subscription.startDate, lang)}</Td>
                  <Td className="text-muted">{date(subscription.renewalDate, lang)}</Td>
                  <Td>{subscription.providerRef ? <Badge tone="ok">linked</Badge> : <Badge tone="warn">not configured</Badge>}</Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
          <Pagination page={data.pagination.page} pages={data.pagination.pages} onChange={setPage} />
        </Card>
      ) : (
        <Card><EmptyState icon={CreditCard} title="No subscriptions" body="Subscriptions appear here as clients are onboarded." /></Card>
      )}
    </>
  );
}

export function AdminAuditPage() {
  const { lang } = useI18n();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search);

  const { data, loading } = useQuery<Paginated<{
    id: string; action: string; entity: string; entityId: string | null; ip: string | null; createdAt: string;
    user: { name: string; email: string } | null;
    organization: { name: string } | null;
  }>>(`/admin/audit${qs({ page, pageSize: 30, search: debounced })}`, [page, debounced]);

  return (
    <>
      <PageHeader title="Audit log" subtitle="Append-only record of everything that changed state." />

      <div className="relative mb-4 max-w-md">
        <Search className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
        <Input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="Filter by action" className="ps-9" />
      </div>

      {loading ? <CardSkeleton rows={10} /> : data && data.items.length > 0 ? (
        <Card>
          <TableWrap>
            <thead><tr><Th>Action</Th><Th>Entity</Th><Th>User</Th><Th>Organization</Th><Th>IP</Th><Th align="end">When</Th></tr></thead>
            <tbody>
              {data.items.map((entry) => (
                <tr key={entry.id}>
                  <Td><Badge>{entry.action}</Badge></Td>
                  <Td className="text-muted">{entry.entity}</Td>
                  <Td>{entry.user?.name ?? 'System'}</Td>
                  <Td className="text-muted">{entry.organization?.name ?? '—'}</Td>
                  <Td className="tabular text-muted">{entry.ip ?? '—'}</Td>
                  <Td align="end" className="text-muted">{dateTime(entry.createdAt, lang)}</Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
          <Pagination page={data.pagination.page} pages={data.pagination.pages} onChange={setPage} />
        </Card>
      ) : (
        <Card><EmptyState icon={Shield} title="Nothing logged yet" body="Actions across the platform will appear here." /></Card>
      )}
    </>
  );
}

export function AdminSettingsPage() {
  const { data, loading } = useQuery<{
    node: string; environment: string; appUrl: string; uptimeSeconds: number;
    storage: { driver: string; maxUploadMb: number };
    ai: { provider: string; model: string; configured: boolean; keyConfigured: boolean };
    session: { ttlHours: number; secureCookies: boolean };
    rateLimit: { windowMinutes: number; max: number };
    database: { connected: boolean };
  }>('/admin/system');

  const rows = data
    ? [
        { label: 'Node', value: data.node, icon: Server },
        { label: 'Environment', value: data.environment, icon: Server },
        { label: 'App URL', value: data.appUrl, icon: Server },
        { label: 'Uptime', value: `${Math.floor(data.uptimeSeconds / 60)} min`, icon: Activity },
        { label: 'Database', value: data.database.connected ? 'Connected' : 'Down', icon: Database },
        { label: 'Storage driver', value: data.storage.driver, icon: HardDrive },
        { label: 'Max upload', value: `${data.storage.maxUploadMb} MB`, icon: HardDrive },
        { label: 'AI provider', value: `${data.ai.provider} (${data.ai.model})`, icon: Server },
        { label: 'AI key configured', value: data.ai.keyConfigured ? 'Yes' : 'No', icon: Shield },
        { label: 'Session TTL', value: `${data.session.ttlHours} hours`, icon: Shield },
        { label: 'Secure cookies', value: data.session.secureCookies ? 'On' : 'Off', icon: Shield },
        { label: 'Rate limit', value: `${data.rateLimit.max} / ${data.rateLimit.windowMinutes} min`, icon: Shield },
      ]
    : [];

  return (
    <>
      <PageHeader title="System" subtitle="Effective runtime configuration. Secrets are reported as present or absent only." />

      {loading ? <CardSkeleton rows={8} /> : (
        <Card className="max-w-3xl">
          <CardHeader title="Runtime" icon={Server} />
          <div className="divide-y divide-line/60">
            {rows.map((row) => (
              <div key={row.label} className="flex items-center gap-3 px-5 py-3">
                <row.icon className="h-4 w-4 shrink-0 text-muted" />
                <span className="flex-1 text-[13px] text-muted">{row.label}</span>
                <span className="text-[13px] font-medium text-fg">{row.value}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}
