/**
 * Team — the people who can sign in to this workspace.
 *
 * Built entirely on `/api/users`, which already existed and already enforces
 * the rules this page has to respect: an agency staff member may look, only an
 * admin may add or change, and only a super admin may mint another one. The UI
 * mirrors those rules rather than restating them — a control that would be
 * refused by the server is not rendered.
 */

import { useState, type FormEvent } from 'react';
import { ShieldCheck, UserPlus, Users } from 'lucide-react';

import { api, qs, type Paginated, type Role } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useQuery, useDebounced } from '../lib/hooks';
import { useI18n } from '../lib/i18n';
import { useRestaurant } from '../lib/restaurant';
import { date, humanize } from '../lib/format';
import {
  Badge, Button, Card, CardSkeleton, EmptyState, ErrorState, Field, Input, Modal, PageHeader,
  Pagination, Select, TableWrap, Td, Th, useToast,
} from '../components/ui';

interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: Role;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  client: { id: string; name: string } | null;
}

const AGENCY_ROLES: Role[] = ['AGENCY_ADMIN', 'AGENCY_STAFF'];
const PORTAL_ROLES: Role[] = ['CLIENT_ADMIN', 'CLIENT_USER'];

function roleTone(role: Role): 'danger' | 'brand' | 'neutral' {
  if (role === 'SUPER_ADMIN') return 'danger';
  if (role === 'AGENCY_ADMIN') return 'brand';
  return 'neutral';
}

/** Add a member. Client portal roles must name the client they belong to. */
function InviteDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const { isSuperAdmin } = useAuth();
  const { restaurants } = useRestaurant();
  const { push } = useToast();

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('AGENCY_STAFF');
  const [clientId, setClientId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsClient = PORTAL_ROLES.includes(role);
  const roles: Role[] = isSuperAdmin ? ['SUPER_ADMIN', ...AGENCY_ROLES, ...PORTAL_ROLES] : [...AGENCY_ROLES, ...PORTAL_ROLES];

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/users', {
        name: name.trim(),
        email: email.trim(),
        password,
        role,
        clientId: needsClient ? clientId : null,
      });
      push({ tone: 'success', title: t('team.created') });
      setName(''); setEmail(''); setPassword(''); setClientId('');
      onDone();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add this member');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={t('team.invite')}>
      <form onSubmit={submit} className="space-y-4">
        <Field label={t('team.name')} required>
          <Input value={name} onChange={(event) => setName(event.target.value)} required minLength={2} maxLength={120} />
        </Field>
        <Field label={t('team.email')} required>
          <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="off" />
        </Field>
        <Field label={t('team.password')} hint={t('team.passwordHint')} required>
          <Input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            minLength={10}
            autoComplete="new-password"
          />
        </Field>
        <Field label={t('team.role')} required>
          <Select value={role} onChange={(event) => setRole(event.target.value as Role)}>
            {roles.map((value) => (
              <option key={value} value={value}>{humanize(value.toLowerCase())}</option>
            ))}
          </Select>
        </Field>
        {needsClient ? (
          <Field label={t('team.clientAccount')} required>
            <Select value={clientId} onChange={(event) => setClientId(event.target.value)} required>
              <option value="">{t('common.none')}</option>
              {restaurants.map((row) => (
                <option key={row.id} value={row.id}>{row.businessName}</option>
              ))}
            </Select>
          </Field>
        ) : null}

        {error ? <p className="text-[13px] text-danger">{error}</p> : null}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" loading={busy} disabled={needsClient && !clientId}>{t('common.create')}</Button>
        </div>
      </form>
    </Modal>
  );
}

export function TeamPage() {
  const { t, lang } = useI18n();
  const { user, canManage, isSuperAdmin } = useAuth();
  const { push } = useToast();
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('');
  const [page, setPage] = useState(1);
  const [inviting, setInviting] = useState(false);
  const debounced = useDebounced(search);

  const { data, loading, error, refetch } = useQuery<Paginated<TeamMember>>(
    `/users${qs({ page, pageSize: 20, search: debounced, role })}`,
    [page, debounced, role],
  );

  const setActive = async (member: TeamMember, isActive: boolean) => {
    try {
      await api.patch(`/users/${member.id}`, { isActive });
      push({ tone: 'success', title: t('team.updated') });
      refetch();
    } catch (err) {
      push({ tone: 'error', title: err instanceof Error ? err.message : 'Could not update this member' });
    }
  };

  const changeRole = async (member: TeamMember, next: Role) => {
    try {
      await api.patch(`/users/${member.id}`, { role: next });
      push({ tone: 'success', title: t('team.updated') });
      refetch();
    } catch (err) {
      push({ tone: 'error', title: err instanceof Error ? err.message : 'Could not update this member' });
    }
  };

  const assignable: Role[] = isSuperAdmin
    ? ['SUPER_ADMIN', ...AGENCY_ROLES, ...PORTAL_ROLES]
    : [...AGENCY_ROLES, ...PORTAL_ROLES];

  return (
    <>
      <PageHeader
        title={t('team.title')}
        subtitle={t('team.subtitle')}
        action={
          canManage ? (
            <Button icon={UserPlus} onClick={() => setInviting(true)}>{t('team.invite')}</Button>
          ) : undefined
        }
      />

      {!canManage ? (
        <p className="mb-4 flex items-center gap-2 text-[13px] text-muted">
          <ShieldCheck className="h-4 w-4" /> {t('team.readOnly')}
        </p>
      ) : null}

      <div className="mb-4 flex flex-wrap gap-2">
        <Input
          value={search}
          onChange={(event) => { setSearch(event.target.value); setPage(1); }}
          placeholder={t('common.search')}
          className="min-w-[220px] flex-1"
        />
        <Select
          value={role}
          onChange={(event) => { setRole(event.target.value); setPage(1); }}
          className="w-52"
          aria-label={t('team.role')}
        >
          <option value="">{t('common.all')}</option>
          {assignable.map((value) => (
            <option key={value} value={value}>{humanize(value.toLowerCase())}</option>
          ))}
        </Select>
      </div>

      {error ? (
        <Card><ErrorState message={error} onRetry={refetch} /></Card>
      ) : loading ? (
        <CardSkeleton rows={8} />
      ) : data && data.items.length > 0 ? (
        <Card>
          <TableWrap>
            <thead>
              <tr>
                <Th>{t('team.name')}</Th>
                <Th>{t('team.role')}</Th>
                <Th>{t('common.client')}</Th>
                <Th>{t('team.lastLogin')}</Th>
                <Th>{t('common.status')}</Th>
                {canManage ? <Th align="end">{t('common.actions')}</Th> : null}
              </tr>
            </thead>
            <tbody>
              {data.items.map((member) => (
                <tr key={member.id}>
                  <Td>
                    <span className="block font-medium text-fg" dir="auto">{member.name}</span>
                    <span className="block text-[12px] text-muted">{member.email}</span>
                  </Td>
                  <Td>
                    {/* A role this account cannot grant is shown, not offered:
                        a select whose value is missing from its options would
                        display the wrong role entirely. */}
                    {canManage && member.id !== user?.id && assignable.includes(member.role) ? (
                      <Select
                        value={member.role}
                        onChange={(event) => void changeRole(member, event.target.value as Role)}
                        className="w-44"
                        aria-label={t('team.role')}
                      >
                        {assignable.map((value) => (
                          <option key={value} value={value}>{humanize(value.toLowerCase())}</option>
                        ))}
                      </Select>
                    ) : (
                      <Badge tone={roleTone(member.role)}>{humanize(member.role.toLowerCase())}</Badge>
                    )}
                  </Td>
                  <Td className="text-muted">{member.client?.name ?? '—'}</Td>
                  <Td className="text-muted">
                    {member.lastLoginAt ? date(member.lastLoginAt, lang) : t('team.never')}
                  </Td>
                  <Td>
                    <Badge tone={member.isActive ? 'ok' : 'neutral'}>
                      {member.isActive ? t('team.active') : t('team.disabled')}
                    </Badge>
                  </Td>
                  {canManage ? (
                    <Td align="end">
                      {/* Deactivating yourself is refused by the server, so the
                          control is not offered on your own row. */}
                      {member.id === user?.id ? (
                        <span className="text-[12.5px] text-muted">—</span>
                      ) : (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => void setActive(member, !member.isActive)}
                        >
                          {member.isActive ? t('team.deactivate') : t('team.activate')}
                        </Button>
                      )}
                    </Td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </TableWrap>
          <Pagination page={data.pagination.page} pages={data.pagination.pages} onChange={setPage} />
        </Card>
      ) : (
        <Card>
          <EmptyState
            icon={Users}
            title={t('team.title')}
            body={t('team.empty')}
            action={canManage ? <Button onClick={() => setInviting(true)}>{t('team.invite')}</Button> : undefined}
          />
        </Card>
      )}

      {canManage ? (
        <InviteDialog open={inviting} onClose={() => setInviting(false)} onDone={refetch} />
      ) : null}
    </>
  );
}
