/**
 * A restaurant's Composio connections, and the agency's consumption view.
 *
 * Shared by the agency's Integrations Center and the restaurant portal: a
 * restaurant owner sees exactly this panel for their own restaurant, which is
 * how an agency hands account linking to the people who own the accounts.
 *
 * Every state shown comes from the server. "Connected" is only what Composio
 * reported ACTIVE at the last check (or what a platform call confirmed, where
 * a verification tool is configured) — never a local assumption.
 */

import { useEffect, useState } from 'react';
import { History, Link2, Plug, RefreshCw } from 'lucide-react';

import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useQuery } from '../lib/hooks';
import { useI18n, type TranslationKey } from '../lib/i18n';
import { dateTime, relative } from '../lib/format';
import { Badge, Button, Card, CardHeader, CardSkeleton, EmptyState, Field, Input, Modal, Select, useToast } from './ui';

type State =
  | 'CONNECTED' | 'DISCONNECTED' | 'PENDING_APPROVAL' | 'TOKEN_EXPIRED' | 'MISSING_PERMISSIONS'
  | 'REAUTHORIZATION_REQUIRED' | 'API_ERROR' | 'UNSUPPORTED';

const TONE: Record<State, 'ok' | 'neutral' | 'warn' | 'danger' | 'brand'> = {
  CONNECTED: 'ok',
  DISCONNECTED: 'neutral',
  PENDING_APPROVAL: 'brand',
  TOKEN_EXPIRED: 'danger',
  MISSING_PERMISSIONS: 'warn',
  REAUTHORIZATION_REQUIRED: 'danger',
  API_ERROR: 'danger',
  UNSUPPORTED: 'neutral',
};

interface AuthConfigOption { id: string; name: string; toolkit: string; managedByComposio: boolean }

interface Catalog {
  configured: boolean;
  reason: string | null;
  platforms: Array<{ key: string; label: string; labelAr: string; supported: boolean; authConfigs: AuthConfigOption[] }>;
  other: AuthConfigOption[];
}

interface Connection {
  id: string;
  toolkit: string;
  platform: string | null;
  accountId: string;
  alias: string | null;
  remoteStatus: string;
  statusReason: string | null;
  state: State;
  verification: 'COMPOSIO_STATUS' | 'PROVIDER_CALL' | null;
  lastCheckedAt: string | null;
  lastSuccessfulSyncAt: string | null;
  lastError: string | null;
  replacing: boolean;
}

const stateKey = (state: State) => `composio.state.${state}` as TranslationKey;

export function ComposioPanel({ clientId }: { clientId: string }) {
  const { t, lang } = useI18n();
  const { user } = useAuth();
  const { push } = useToast();
  const canManage = user?.permissions?.includes('integrations.manage') ?? false;

  const catalog = useQuery<Catalog>('/composio/catalog');
  const connections = useQuery<{ items: Connection[] }>(`/composio/${clientId}/connections`, [clientId]);

  const [connecting, setConnecting] = useState<{ label: string; configs: AuthConfigOption[] } | null>(null);
  const [authConfigId, setAuthConfigId] = useState('');
  const [alias, setAlias] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [historyOf, setHistoryOf] = useState<Connection | null>(null);

  const sync = async (quiet = false) => {
    setBusy('sync');
    try {
      await api.post(`/composio/${clientId}/sync`);
      if (!quiet) push({ tone: 'success', title: t('composio.synced') });
    } catch (err) {
      push({ tone: 'error', title: t('composio.syncNow'), body: err instanceof Error ? err.message : undefined });
    } finally {
      setBusy(null);
      connections.refetch();
    }
  };

  /*
   * Back from Composio's hosted login. The query carries nothing the server
   * trusts; it only says "look again", and the server re-reads Composio for
   * this restaurant's own user id.
   */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('composio') !== 'returned') return;
    push({ tone: 'info', title: t('composio.returned') });
    params.delete('composio');
    params.delete('client');
    window.history.replaceState({}, '', `${window.location.pathname}${params.size ? `?${params}` : ''}`);
    void sync(false);
    // Once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openConnect = (label: string, configs: AuthConfigOption[]) => {
    setConnecting({ label, configs });
    setAuthConfigId(configs[0]?.id ?? '');
    setAlias('');
  };

  const startLink = async (path: string, body?: Record<string, unknown>) => {
    setBusy('link');
    try {
      const { redirectUrl } = await api.post<{ redirectUrl: string }>(path, body);
      window.location.href = redirectUrl;
    } catch (err) {
      push({ tone: 'error', title: t('composio.connect'), body: err instanceof Error ? err.message : undefined });
      setBusy(null);
    }
  };

  const test = async (row: Connection) => {
    setBusy(row.id);
    try {
      const result = await api.post<Connection>(`/composio/connections/${row.id}/test`);
      push({
        tone: result.state === 'CONNECTED' ? 'success' : 'error',
        title: `${row.alias ?? row.toolkit}: ${t(stateKey(result.state))}`,
        body: result.lastError ?? result.statusReason ?? undefined,
      });
    } catch (err) {
      push({ tone: 'error', title: t('composio.test'), body: err instanceof Error ? err.message : undefined });
    } finally {
      setBusy(null);
      connections.refetch();
    }
  };

  const remove = async (row: Connection) => {
    if (!window.confirm(t('composio.confirmDisconnect'))) return;
    setBusy(row.id);
    try {
      await api.delete(`/composio/connections/${row.id}`);
    } catch (err) {
      push({ tone: 'error', title: t('composio.disconnect'), body: err instanceof Error ? err.message : undefined });
    } finally {
      setBusy(null);
      connections.refetch();
    }
  };

  const rows = connections.data?.items ?? [];
  const families = catalog.data?.platforms ?? [];

  return (
    <Card className="mb-4">
      <CardHeader
        title={t('composio.title')}
        subtitle={t('composio.subtitle')}
        action={catalog.data?.configured ? (
          <Button size="sm" variant="secondary" icon={RefreshCw} loading={busy === 'sync'} onClick={() => sync()}>
            {t('composio.syncNow')}
          </Button>
        ) : undefined}
      />
      <div className="p-5 pt-0">
        {catalog.loading || connections.loading ? (
          <CardSkeleton rows={3} />
        ) : catalog.error ? (
          <p className="rounded-lg border border-danger/25 bg-danger/10 p-3 text-[13px] text-fg">{catalog.error}</p>
        ) : !catalog.data?.configured ? (
          <div className="rounded-lg border border-warn/25 bg-warn/10 p-3 text-[13px] text-fg">
            <p className="font-medium">{t('composio.notConfigured')}</p>
            <p dir="ltr" className="mt-1 text-muted">{catalog.data?.reason}</p>
          </div>
        ) : (
          <>
            {!canManage ? <p className="mb-3 text-[12px] text-muted">{t('composio.manageDenied')}</p> : null}
            <div className="grid items-start gap-3 md:grid-cols-2 xl:grid-cols-3">
              {families.map((family) => {
                const mine = rows.filter((row) => family.authConfigs.some((config) => config.toolkit === row.toolkit) || row.platform === family.key);
                return (
                  <div key={family.key} className="rounded-xl border border-line p-4">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-medium text-fg">{lang === 'ar' ? family.labelAr : family.label}</p>
                      {!family.supported ? <Badge tone={TONE.UNSUPPORTED} dot>{t(stateKey('UNSUPPORTED'))}</Badge> : null}
                    </div>

                    {!family.supported ? (
                      <p className="mt-2 text-[12px] leading-snug text-muted">{t('composio.unsupportedBody')}</p>
                    ) : mine.length === 0 ? (
                      <p className="mt-2 text-[12px] text-muted">{t('composio.noAccounts')}</p>
                    ) : (
                      <ul className="mt-3 space-y-2.5">
                        {mine.map((row) => (
                          <li key={row.id} className="rounded-lg bg-elevated p-2.5 text-[12px]">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="min-w-0 truncate font-medium text-fg">{row.alias ?? row.toolkit}</span>
                              <Badge tone={TONE[row.state]} dot>{t(stateKey(row.state))}</Badge>
                            </div>
                            <p dir="ltr" className="mt-1 truncate font-mono text-[11px] text-muted">{row.accountId}</p>
                            <p className="mt-1 text-muted">
                              {t('integration.lastSuccessfulSync')}: {row.lastSuccessfulSyncAt ? relative(row.lastSuccessfulSyncAt, lang) : '—'}
                              {row.verification ? ` · ${row.verification === 'PROVIDER_CALL' ? t('composio.verifiedProvider') : t('composio.verifiedStatus')}` : ''}
                            </p>
                            {row.state !== 'CONNECTED' && (row.lastError || row.statusReason) ? (
                              <p dir="auto" className="mt-1 line-clamp-2 text-warn">{row.lastError ?? row.statusReason}</p>
                            ) : null}
                            <div className="mt-2 flex flex-wrap gap-1.5">
                              <Button size="sm" variant="secondary" loading={busy === row.id} disabled={Boolean(busy)} onClick={() => test(row)}>
                                {t('composio.test')}
                              </Button>
                              {canManage ? (
                                <Button size="sm" variant="secondary" disabled={Boolean(busy)}
                                  onClick={() => startLink(`/composio/connections/${row.id}/reconnect`)}>
                                  {t('composio.reconnect')}
                                </Button>
                              ) : null}
                              <Button size="sm" variant="ghost" icon={History} onClick={() => setHistoryOf(row)}>
                                {t('composio.history')}
                              </Button>
                              {canManage ? (
                                <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => remove(row)}>
                                  {t('composio.disconnect')}
                                </Button>
                              ) : null}
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}

                    {family.supported && canManage ? (
                      <Button className="mt-3" size="sm" variant={mine.length ? 'secondary' : 'primary'} icon={Plug}
                        onClick={() => openConnect(lang === 'ar' ? family.labelAr : family.label, family.authConfigs)}>
                        {mine.length ? t('composio.addAnother') : t('composio.connect')}
                      </Button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      <Modal
        open={Boolean(connecting)}
        onClose={() => setConnecting(null)}
        title={`${t('composio.connect')} — ${connecting?.label ?? ''}`}
        size="sm"
        footer={(
          <>
            <Button variant="secondary" onClick={() => setConnecting(null)}>{t('common.cancel')}</Button>
            <Button icon={Link2} loading={busy === 'link'} disabled={!authConfigId}
              onClick={() => startLink(`/composio/${clientId}/connections`, { authConfigId, alias: alias.trim() || undefined })}>
              {t('composio.start')}
            </Button>
          </>
        )}
      >
        <div className="space-y-4">
          {connecting && connecting.configs.length > 1 ? (
            <Field label={t('composio.chooseApp')}>
              <Select value={authConfigId} onChange={(event) => setAuthConfigId(event.target.value)}>
                {connecting.configs.map((config) => <option key={config.id} value={config.id}>{config.name}</option>)}
              </Select>
            </Field>
          ) : null}
          <Field label={t('composio.alias')} hint={t('composio.aliasHint')}>
            <Input value={alias} maxLength={80} onChange={(event) => setAlias(event.target.value)} />
          </Field>
        </div>
      </Modal>

      <HistoryModal row={historyOf} onClose={() => setHistoryOf(null)} />
    </Card>
  );
}

function HistoryModal({ row, onClose }: { row: Connection | null; onClose: () => void }) {
  const { t, lang } = useI18n();
  const { data, loading } = useQuery<{ items: Array<{ id: string; action: string; createdAt: string; user: { name: string } | null }> }>(
    row ? `/composio/connections/${row.id}/history` : null,
    [row?.id],
  );
  return (
    <Modal open={Boolean(row)} onClose={onClose} title={`${t('composio.history')} — ${row?.alias ?? row?.toolkit ?? ''}`} size="sm">
      {loading ? <CardSkeleton rows={3} /> : data && data.items.length > 0 ? (
        <ul className="divide-y divide-line/60 text-[13px]">
          {data.items.map((event) => (
            <li key={event.id} className="flex justify-between gap-3 py-2">
              <span dir="ltr" className="font-mono text-[12px] text-fg">{event.action.replace('composio.', '')}</span>
              <span className="text-muted">{event.user?.name ?? '—'} · {dateTime(event.createdAt, lang)}</span>
            </li>
          ))}
        </ul>
      ) : <EmptyState compact icon={History} title={t('composio.noHistory')} body="" />}
    </Modal>
  );
}

interface Usage {
  totalRestaurants: number;
  totalConnections: number;
  connectionsPerRestaurant: number;
  perRestaurant: Array<{ clientId: string; name: string; direct: number; composio: number; composioActive: number }>;
  calls: { thisMonth: number; failed: number; note: string };
  syncOperations: { thisMonth: number; failed: number };
  cost: { estimatedUsd: number | null; reason: string | null };
}

/** The agency's consumption across every restaurant it runs. */
export function UsagePanel() {
  const { t } = useI18n();
  const { user } = useAuth();
  const allowed = user?.permissions?.includes('usage.view') ?? false;
  const { data, loading } = useQuery<Usage>(allowed ? '/composio/usage' : null);
  if (!allowed) return null;

  const tiles: Array<[string, string]> = data ? [
    [t('usage.restaurants'), String(data.totalRestaurants)],
    [t('usage.connections'), `${data.totalConnections} · ${data.connectionsPerRestaurant} ${t('usage.perRestaurant')}`],
    [t('usage.calls'), `${data.calls.thisMonth} · ${t('usage.failed')} ${data.calls.failed}`],
    [t('usage.syncs'), `${data.syncOperations.thisMonth} · ${t('usage.failed')} ${data.syncOperations.failed}`],
    [t('usage.cost'), data.cost.estimatedUsd === null ? '—' : `$${data.cost.estimatedUsd.toFixed(2)}`],
  ] : [];

  return (
    <Card className="mb-4">
      <CardHeader title={t('usage.title')} />
      <div className="p-5 pt-0">
        {loading || !data ? <CardSkeleton rows={2} /> : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
              {tiles.map(([label, value]) => (
                <div key={label} className="rounded-lg border border-line p-3">
                  <p className="text-[12px] text-muted">{label}</p>
                  <p className="tabular mt-1 text-[15px] font-semibold text-fg">{value}</p>
                </div>
              ))}
            </div>
            <p dir="ltr" className="mt-3 text-[12px] text-muted">{data.calls.note}{data.cost.reason ? ` ${data.cost.reason}` : ''}</p>
            {data.perRestaurant.length > 0 ? (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="text-start text-muted">
                      <th className="py-1.5 text-start font-medium">{t('usage.restaurants')}</th>
                      <th className="py-1.5 text-end font-medium">{t('usage.direct')}</th>
                      <th className="py-1.5 text-end font-medium">Composio</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line/60">
                    {data.perRestaurant.map((row) => (
                      <tr key={row.clientId}>
                        <td className="py-1.5 text-fg">{row.name}</td>
                        <td className="tabular py-1.5 text-end">{row.direct}</td>
                        <td className="tabular py-1.5 text-end">{row.composioActive} / {row.composio}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </>
        )}
      </div>
    </Card>
  );
}
