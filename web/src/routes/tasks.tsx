/** Marketing tasks and follow-ups. */

import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, Check, ListChecks, Plus, Search, Trash2 } from 'lucide-react';

import {
  api, qs, TASK_PRIORITIES, TASK_STATUSES,
  type Paginated, type RestaurantRef, type TaskPriority, type TaskStatus,
} from '../lib/api';
import { useDebounced, useQuery } from '../lib/hooks';
import { useI18n } from '../lib/i18n';
import { date, humanize } from '../lib/format';
import {
  Badge, Button, Card, CardHeader, CardSkeleton, EmptyState, ErrorState, Field, Input, Modal,
  PageHeader, Pagination, Select, Textarea, useToast, type BadgeTone,
} from '../components/ui';

interface TaskRow {
  id: string;
  title: string;
  details: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  dueAt: string | null;
  completedAt: string | null;
  restaurant: RestaurantRef | null;
  campaign: { id: string; name: string } | null;
}

interface TasksResponse extends Paginated<TaskRow> {
  summary: { open: number; overdue: number };
}

const PRIORITY_TONE: Record<TaskPriority, BadgeTone> = {
  LOW: 'neutral',
  MEDIUM: 'brand',
  HIGH: 'warn',
  URGENT: 'danger',
};

function TaskForm({
  open, onClose, onSaved, restaurantId,
}: { open: boolean; onClose: () => void; onSaved: () => void; restaurantId?: string }) {
  const { t } = useI18n();
  const { push } = useToast();
  const restaurants = useQuery<Paginated<RestaurantRef>>(`/restaurants${qs({ pageSize: 100 })}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blank = {
    title: '',
    details: '',
    restaurantId: restaurantId ?? '',
    status: 'TODO' as TaskStatus,
    priority: 'MEDIUM' as TaskPriority,
    dueAt: '',
  };
  const [form, setForm] = useState(blank);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/tasks', {
        ...form,
        // A task with no restaurant is general workspace work, which the API allows.
        restaurantId: (restaurantId ?? form.restaurantId) || null,
        dueAt: form.dueAt ? new Date(form.dueAt).toISOString() : null,
      });
      push({ tone: 'success', title: 'Task added' });
      onSaved();
      onClose();
      setForm(blank);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the task');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New task"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button form="task-form" type="submit" loading={busy}>{t('common.create')}</Button>
        </>
      }
    >
      <form id="task-form" onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <Field label="Title" required className="sm:col-span-2">
          <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required placeholder="Send August report to Sabah Al Leil" />
        </Field>
        {restaurantId ? null : (
          <Field label={t('common.restaurant')} hint="Leave empty for general work.">
            <Select value={form.restaurantId} onChange={(e) => setForm({ ...form, restaurantId: e.target.value })}>
              <option value="">{t('common.none')}</option>
              {restaurants.data?.items.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </Select>
          </Field>
        )}
        <Field label="Priority">
          <Select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value as TaskPriority })}>
            {TASK_PRIORITIES.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}
          </Select>
        </Field>
        <Field label="Due date">
          <Input type="date" value={form.dueAt} onChange={(e) => setForm({ ...form, dueAt: e.target.value })} />
        </Field>
        <Field label={t('common.status')}>
          <Select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as TaskStatus })}>
            {TASK_STATUSES.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}
          </Select>
        </Field>
        <Field label="Details" className="sm:col-span-2" error={error ?? undefined}>
          <Textarea value={form.details} onChange={(e) => setForm({ ...form, details: e.target.value })} rows={3} />
        </Field>
      </form>
    </Modal>
  );
}

export function TasksPage({ restaurantId, embedded = false }: { restaurantId?: string; embedded?: boolean } = {}) {
  const { t, lang } = useI18n();
  const { push } = useToast();
  const [params] = useSearchParams();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [priority, setPriority] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const debounced = useDebounced(search);

  const scoped = restaurantId ?? params.get('restaurant') ?? undefined;

  const { data, loading, error, refetch } = useQuery<TasksResponse>(
    `/tasks${qs({ page, pageSize: 20, search: debounced, status, priority, restaurantId: scoped })}`,
    [page, debounced, status, priority, scoped],
  );

  const update = async (task: TaskRow, next: Partial<Pick<TaskRow, 'status'>>) => {
    try {
      await api.patch(`/tasks/${task.id}`, next);
      refetch();
    } catch (err) {
      push({ tone: 'error', title: 'Could not update', body: err instanceof Error ? err.message : undefined });
    }
  };

  const remove = async (task: TaskRow) => {
    try {
      await api.delete(`/tasks/${task.id}`);
      push({ tone: 'success', title: 'Task deleted' });
      refetch();
    } catch (err) {
      push({ tone: 'error', title: 'Could not delete', body: err instanceof Error ? err.message : undefined });
    }
  };

  const newButton = <Button icon={Plus} onClick={() => setCreating(true)}>New task</Button>;
  const now = Date.now();

  return (
    <>
      {embedded ? null : (
        <PageHeader
          title={t('nav.tasks')}
          subtitle={
            data
              ? `${data.summary.open} open${data.summary.overdue > 0 ? ` · ${data.summary.overdue} overdue` : ''}`
              : undefined
          }
          action={newButton}
        />
      )}

      <div className="mb-4 flex flex-wrap gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <Input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder={t('common.search')} className="ps-9" />
        </div>
        <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="w-40">
          <option value="">{t('common.status')}</option>
          {TASK_STATUSES.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}
        </Select>
        <Select value={priority} onChange={(e) => { setPriority(e.target.value); setPage(1); }} className="w-40">
          <option value="">Priority</option>
          {TASK_PRIORITIES.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}
        </Select>
        {embedded ? newButton : null}
      </div>

      {error ? (
        <Card><ErrorState message={error} onRetry={refetch} /></Card>
      ) : loading ? (
        <CardSkeleton rows={6} />
      ) : data && data.items.length > 0 ? (
        <>
          <Card>
            <CardHeader title={t('nav.tasks')} icon={ListChecks} />
            <div className="divide-y divide-line/60">
              {data.items.map((task) => {
                const done = task.status === 'DONE';
                const overdue = !done && task.dueAt !== null && new Date(task.dueAt).getTime() < now;
                return (
                  <div key={task.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
                    <button
                      onClick={() => update(task, { status: done ? 'TODO' : 'DONE' })}
                      aria-label={done ? 'Mark as not done' : 'Mark as done'}
                      className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md border transition-colors ${
                        done ? 'border-ok bg-ok/15 text-ok' : 'border-line text-transparent hover:border-brand'
                      }`}
                    >
                      <Check className="h-3.5 w-3.5" />
                    </button>

                    <div className="min-w-0 flex-1">
                      <p className={`text-[14px] font-medium ${done ? 'text-muted line-through' : 'text-fg'}`}>
                        {task.title}
                      </p>
                      {task.details ? <p className="mt-0.5 text-[13px] text-muted">{task.details}</p> : null}
                      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[12px] text-muted">
                        {task.restaurant && !embedded ? (
                          <Link to={`/restaurants/${task.restaurant.id}`} className="hover:text-brand">
                            {task.restaurant.name}
                          </Link>
                        ) : null}
                        {task.campaign ? <span>· {task.campaign.name}</span> : null}
                        {task.dueAt ? (
                          <span className={overdue ? 'flex items-center gap-1 text-danger' : undefined}>
                            {overdue ? <AlertTriangle className="h-3 w-3" /> : null}
                            {date(task.dueAt, lang)}
                          </span>
                        ) : null}
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      <Badge tone={PRIORITY_TONE[task.priority]}>{humanize(task.priority)}</Badge>
                      <Select
                        value={task.status}
                        onChange={(e) => update(task, { status: e.target.value as TaskStatus })}
                        className="w-36"
                        aria-label={t('common.status')}
                      >
                        {TASK_STATUSES.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}
                      </Select>
                      <button
                        onClick={() => remove(task)}
                        className="grid h-8 w-8 place-items-center rounded-lg text-muted transition-colors hover:bg-danger/10 hover:text-danger"
                        aria-label={t('common.delete')}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
          <Card className="mt-4"><Pagination page={data.pagination.page} pages={data.pagination.pages} onChange={setPage} /></Card>
        </>
      ) : (
        <Card>
          <EmptyState
            icon={ListChecks}
            title={debounced || status ? t('empty.search.title') : t('empty.tasks.title')}
            body={debounced || status ? t('empty.search.body') : t('empty.tasks.body')}
            action={!debounced ? newButton : undefined}
          />
        </Card>
      )}

      <TaskForm open={creating} onClose={() => setCreating(false)} onSaved={refetch} restaurantId={scoped} />
    </>
  );
}
