/**
 * Meta Campaigns — drafting, reviewing and publishing a real advertisement.
 *
 * The API deliberately splits this into four calls: draft, preview, approve,
 * publish. This page keeps that shape instead of collapsing it into one button,
 * because publishing spends money in somebody's ad account and creates objects
 * a human then has to find and clean up.
 *
 * Two rules the UI does not get to break:
 *
 *   Nothing here decides that an advertisement is published. Status, provider
 *   ids and the manager link are printed exactly as the server returned them —
 *   a row saying PUBLISHED means Meta accepted it.
 *
 *   Blockers come from the preview endpoint, not from guesses made here. If the
 *   server says the account is not connected, that is what the operator reads.
 */

import { useMemo, useState, type FormEvent } from 'react';
import { ExternalLink, Megaphone, Plus, ShieldCheck, TriangleAlert, Upload } from 'lucide-react';

import { api, qs, type Platform } from '../lib/api';
import { useQuery } from '../lib/hooks';
import { useI18n } from '../lib/i18n';
import { useRestaurant } from '../lib/restaurant';
import { date, money } from '../lib/format';
import {
  Badge, Button, Card, CardHeader, CardSkeleton, Drawer, EmptyState, ErrorState, Field, Input,
  Modal, PageHeader, Select, Spinner, TableWrap, Td, Textarea, Th, useToast, type BadgeTone,
} from '../components/ui';

// Meta's outcome-era objectives. The older ones are rejected by the API, so the
// list mirrors the server's enum rather than offering choices that would 400.
const OBJECTIVES = [
  ['OUTCOME_AWARENESS', 'Awareness'],
  ['OUTCOME_TRAFFIC', 'Traffic'],
  ['OUTCOME_ENGAGEMENT', 'Engagement'],
  ['OUTCOME_LEADS', 'Leads'],
  ['OUTCOME_SALES', 'Sales'],
  ['OUTCOME_APP_PROMOTION', 'App promotion'],
] as const;

const STATUS_TONES: Record<string, BadgeTone> = {
  DRAFT: 'neutral',
  APPROVED: 'brand',
  PUBLISHING: 'warn',
  PUBLISHED: 'ok',
  FAILED: 'danger',
  REQUIRES_REAUTH: 'danger',
};

interface Publication {
  id: string;
  clientId: string;
  platform: Platform;
  status: string;
  name: string;
  objective: string;
  dailyBudget: string;
  currency: string;
  startDate: string;
  endDate: string;
  countries: string[];
  headline: string;
  message: string;
  linkUrl: string;
  providerAdId: string | null;
  providerCampaignId: string | null;
  managerUrl: string | null;
  errorMessage: string | null;
  errorStatus: number | null;
  publishedAt: string | null;
  createdAt: string;
}

interface PreflightCheck {
  key: string;
  label: string;
  outcome: 'PASS' | 'WARNING' | 'BLOCK';
  detail: string;
  fix: string | null;
}

interface PreflightReport {
  outcome: 'PASS' | 'WARNING' | 'BLOCK';
  canPublish: boolean;
  checks: PreflightCheck[];
  summary: string;
}

interface PreviewResponse {
  publication: Publication;
  client: { id: string; name: string; businessName: string };
  account: {
    connection: string;
    accountName: string | null;
    selected: Array<{ kind: string; name: string; externalId: string }>;
  };
  creative: { id: string; width: number; height: number; preset?: string; placement?: string } | null;
  mediaKind: 'IMAGE' | 'VIDEO' | null;
  mediaPresent: boolean | null;
  budget: { daily: number; currency: string; estimatedTotal: number };
  audience: { countries: string[] };
  readyToPublish: boolean;
  blockers: string[];
  confirmation: string;
}

interface CreativeOption {
  id: string;
  clientId: string;
  preset: string;
  width: number;
  height: number;
  url: string;
  status: string;
}

interface VideoOption {
  id: string;
  clientId: string;
  placement: string;
  width: number;
  height: number;
  durationSeconds: number;
}

// ---------------------------------------------------------------- draft form

function DraftModal({
  open, clientId, onClose, onCreated,
}: { open: boolean; clientId: string; onClose: () => void; onCreated: () => void }) {
  const { push } = useToast();
  const [saving, setSaving] = useState(false);

  const creatives = useQuery<{ creatives: CreativeOption[] }>(open ? '/creatives' : null, [open]);
  const videos = useQuery<{ videos: VideoOption[] }>(open ? '/videos' : null, [open]);

  const mine = useMemo(
    () => (creatives.data?.creatives ?? []).filter((row) => row.clientId === clientId),
    [creatives.data, clientId],
  );
  const myVideos = useMemo(
    () => (videos.data?.videos ?? []).filter((row) => row.clientId === clientId),
    [videos.data, clientId],
  );

  const today = new Date();
  const inAWeek = new Date(today.getTime() + 7 * 86_400_000);

  const [form, setForm] = useState({
    // `media` carries its own kind, because the server requires exactly one of
    // creativeId or videoCreativeId and will reject both.
    media: '',
    name: '',
    objective: 'OUTCOME_TRAFFIC' as (typeof OBJECTIVES)[number][0],
    dailyBudget: '25',
    currency: 'USD',
    startDate: today.toISOString().slice(0, 10),
    endDate: inAWeek.toISOString().slice(0, 10),
    countries: 'JO',
    linkUrl: '',
    headline: '',
    message: '',
    callToAction: '',
  });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const [kind, id] = form.media.split(':');
    if (!id) {
      push({ tone: 'error', title: 'Attach a rendered creative or video first' });
      return;
    }

    setSaving(true);
    try {
      await api.post('/publications', {
        clientId,
        platform: 'FACEBOOK',
        ...(kind === 'video' ? { videoCreativeId: id } : { creativeId: id }),
        name: form.name.trim(),
        objective: form.objective,
        dailyBudget: Number(form.dailyBudget),
        currency: form.currency.trim().toUpperCase(),
        startDate: form.startDate,
        endDate: form.endDate,
        countries: form.countries.split(',').map((code) => code.trim().toUpperCase()).filter(Boolean),
        linkUrl: form.linkUrl.trim(),
        message: form.message.trim(),
        headline: form.headline.trim(),
        callToAction: form.callToAction.trim() || undefined,
      });
      push({ tone: 'success', title: 'Draft created', body: 'Nothing has been sent to Meta yet.' });
      onCreated();
      onClose();
    } catch (err) {
      push({ tone: 'error', title: 'Could not create the draft', body: err instanceof Error ? err.message : undefined });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New advertisement"
      subtitle="This creates a draft. Publishing is a separate, confirmed step."
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="draft-form" loading={saving}>Create draft</Button>
        </>
      }
    >
      <form id="draft-form" onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <Field label="Creative" required className="sm:col-span-2">
          <Select value={form.media} onChange={(event) => setForm({ ...form, media: event.target.value })} required>
            <option value="">
              {creatives.loading || videos.loading ? 'Loading…' : 'Choose rendered artwork'}
            </option>
            {mine.map((row) => (
              <option key={row.id} value={`image:${row.id}`}>
                {row.preset.replace(/_/g, ' ').toLowerCase()} · {row.width}×{row.height} · {row.status.toLowerCase()}
              </option>
            ))}
            {myVideos.map((row) => (
              <option key={row.id} value={`video:${row.id}`}>
                video · {row.placement.replace(/_/g, ' ').toLowerCase()} · {row.durationSeconds}s
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Name" required>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Weekend brunch — August" required maxLength={120} />
        </Field>
        <Field label="Objective" required>
          <Select value={form.objective} onChange={(e) => setForm({ ...form, objective: e.target.value as typeof form.objective })}>
            {OBJECTIVES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </Select>
        </Field>

        <Field label="Daily budget" required hint="Meta spends up to this much per day.">
          <Input type="number" min="1" step="1" value={form.dailyBudget} onChange={(e) => setForm({ ...form, dailyBudget: e.target.value })} required />
        </Field>
        <Field label="Currency" required>
          <Input value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} maxLength={3} required />
        </Field>

        <Field label="Starts" required>
          <Input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} required />
        </Field>
        <Field label="Ends" required>
          <Input type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} required />
        </Field>

        <Field label="Countries" required hint="Two-letter codes, comma separated.">
          <Input value={form.countries} onChange={(e) => setForm({ ...form, countries: e.target.value })} placeholder="JO, AE" required />
        </Field>
        <Field label="Call to action">
          <Input value={form.callToAction} onChange={(e) => setForm({ ...form, callToAction: e.target.value })} placeholder="ORDER_NOW" maxLength={40} />
        </Field>

        <Field label="Destination link" required className="sm:col-span-2">
          <Input type="url" value={form.linkUrl} onChange={(e) => setForm({ ...form, linkUrl: e.target.value })} placeholder="https://…" required />
        </Field>
        <Field label="Headline" required className="sm:col-span-2">
          <Input value={form.headline} onChange={(e) => setForm({ ...form, headline: e.target.value })} required maxLength={120} />
        </Field>
        <Field label="Primary text" required className="sm:col-span-2">
          <Textarea rows={4} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} required maxLength={2000} />
        </Field>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- review

function ReviewDrawer({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged: () => void }) {
  const { lang } = useI18n();
  const { push } = useToast();
  const [busy, setBusy] = useState<'approve' | 'publish' | null>(null);
  const [confirming, setConfirming] = useState(false);

  const { data, loading, error, refetch } = useQuery<PreviewResponse>(id ? `/publications/${id}/preview` : null, [id]);

  /*
   * Preflight asks every question at once, before anything is created at Meta.
   * The preview endpoint reports its own blockers; this adds the checks that
   * only matter at launch — approval, currency against the ad account, dates,
   * whether the file is still in storage.
   */
  const check = useQuery<PreflightReport>(id ? `/publications/${id}/preflight` : null, [id, busy]);

  const approve = async () => {
    if (!id) return;
    setBusy('approve');
    try {
      await api.post(`/publications/${id}/approve`);
      push({ tone: 'success', title: 'Approved', body: 'Still not published — that is the next step.' });
      refetch();
      onChanged();
    } catch (err) {
      push({ tone: 'error', title: 'Could not approve', body: err instanceof Error ? err.message : undefined });
    } finally {
      setBusy(null);
    }
  };

  const publish = async () => {
    if (!id) return;
    setConfirming(false);
    setBusy('publish');
    try {
      // A provider failure comes back as a result, not an exception, so both
      // outcomes are reported from what the server actually said.
      const result = await api.post<{ published: boolean; error: { message: string | null } | null }>(
        `/publications/${id}/publish`,
      );
      if (result.published) push({ tone: 'success', title: 'Published to Meta' });
      else push({ tone: 'error', title: 'Meta rejected the publish', body: result.error?.message ?? undefined });
    } catch (err) {
      push({ tone: 'error', title: 'Publish failed', body: err instanceof Error ? err.message : undefined });
    } finally {
      setBusy(null);
      refetch();
      onChanged();
    }
  };

  const publication = data?.publication;

  return (
    <>
      <Drawer
        open={Boolean(id)}
        onClose={onClose}
        title={publication?.name ?? 'Advertisement'}
        footer={
          data ? (
            <div className="flex gap-2">
              <Button
                variant="secondary"
                className="flex-1"
                icon={ShieldCheck}
                onClick={approve}
                loading={busy === 'approve'}
                disabled={publication?.status !== 'DRAFT'}
              >
                Approve
              </Button>
              <Button
                className="flex-1"
                icon={Upload}
                onClick={() => setConfirming(true)}
                loading={busy === 'publish'}
                // Both gates: the server's own readiness, and preflight.
                disabled={!data.readyToPublish || check.data?.canPublish === false}
              >
                Publish
              </Button>
            </div>
          ) : null
        }
      >
        {loading ? (
          <div className="grid place-items-center py-16"><Spinner className="h-6 w-6" /></div>
        ) : error ? (
          <ErrorState message={error} onRetry={refetch} />
        ) : data && publication ? (
          <div className="space-y-4 text-[13px]">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={STATUS_TONES[publication.status] ?? 'neutral'} dot>
                {publication.status.replace(/_/g, ' ').toLowerCase()}
              </Badge>
              <span className="text-muted">{data.client.businessName}</span>
            </div>

            {data.blockers.length > 0 ? (
              <div className="rounded-xl border border-danger/25 bg-danger/10 p-3">
                {data.blockers.map((blocker) => (
                  <p key={blocker} className="flex gap-2 text-fg">
                    <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" /> {blocker}
                  </p>
                ))}
              </div>
            ) : null}

            {check.data ? (
              <section>
                <p className="mb-1.5 text-[11px] uppercase tracking-wide text-muted">Preflight</p>
                <p className="mb-2 text-muted">{check.data.summary}</p>
                <div className="space-y-1">
                  {check.data.checks.map((row) => (
                    <div key={row.key} className="flex items-start gap-2">
                      <span
                        className={
                          row.outcome === 'BLOCK'
                            ? 'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-danger'
                            : row.outcome === 'WARNING'
                              ? 'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-warn'
                              : 'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-ok'
                        }
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-fg">{row.label}</span>
                        <span className="block text-[12px] text-muted">{row.detail}</span>
                        {row.fix ? <span className="block text-[12px] text-brand">{row.fix}</span> : null}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            <section>
              <p className="mb-1.5 text-[11px] uppercase tracking-wide text-muted">Ad account</p>
              <p className="text-fg">{data.account.accountName ?? 'No account name reported'}</p>
              <p className="text-muted">Connection: {data.account.connection.toLowerCase()}</p>
              {data.account.selected.map((account) => (
                <p key={account.externalId} className="text-muted">
                  {account.kind.replace(/_/g, ' ').toLowerCase()}: {account.name}
                </p>
              ))}
            </section>

            <section>
              <p className="mb-1.5 text-[11px] uppercase tracking-wide text-muted">Budget</p>
              <p className="text-fg">
                {money(data.budget.daily, lang)} {data.budget.currency} per day
              </p>
              <p className="text-muted">
                Up to {money(data.budget.estimatedTotal, lang)} {data.budget.currency} across{' '}
                {date(publication.startDate, lang)} → {date(publication.endDate, lang)}
              </p>
            </section>

            <section>
              <p className="mb-1.5 text-[11px] uppercase tracking-wide text-muted">Audience</p>
              <p className="text-fg">{data.audience.countries.join(', ') || '—'}</p>
            </section>

            <section>
              <p className="mb-1.5 text-[11px] uppercase tracking-wide text-muted">Creative</p>
              {data.creative ? (
                <p className="text-fg">
                  {data.mediaKind === 'VIDEO' ? 'Video' : 'Image'} · {data.creative.width}×{data.creative.height}
                  {data.mediaPresent === false ? ' · missing from storage' : ''}
                </p>
              ) : (
                <p className="text-muted">Nothing attached.</p>
              )}
              <p className="mt-2 font-medium text-fg">{publication.headline}</p>
              <p className="whitespace-pre-wrap text-muted">{publication.message}</p>
              <p className="mt-1 break-all text-muted">{publication.linkUrl}</p>
            </section>

            {/* Provider ids are printed only when Meta returned them. */}
            {publication.providerAdId || publication.managerUrl ? (
              <section>
                <p className="mb-1.5 text-[11px] uppercase tracking-wide text-muted">In Meta</p>
                {publication.providerAdId ? <p className="text-muted">Ad: {publication.providerAdId}</p> : null}
                {publication.providerCampaignId ? <p className="text-muted">Campaign: {publication.providerCampaignId}</p> : null}
                {publication.managerUrl ? (
                  <a href={publication.managerUrl} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1.5 text-brand hover:underline">
                    Open in Ads Manager <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                ) : null}
              </section>
            ) : null}

            {publication.errorMessage ? (
              <section>
                <p className="mb-1.5 text-[11px] uppercase tracking-wide text-muted">Last error from Meta</p>
                <p className="text-danger">{publication.errorMessage}</p>
                {publication.errorStatus ? <p className="text-muted">HTTP {publication.errorStatus}</p> : null}
              </section>
            ) : null}
          </div>
        ) : null}
      </Drawer>

      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Publish to Meta"
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirming(false)}>Cancel</Button>
            <Button onClick={publish}>Publish</Button>
          </>
        }
      >
        <p className="text-[13px] leading-relaxed text-muted">{data?.confirmation}</p>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------- page

export function MetaCampaignsPage() {
  const { t, lang } = useI18n();
  const { current, currentId } = useRestaurant();
  const [drafting, setDrafting] = useState(false);
  const [reviewing, setReviewing] = useState<string | null>(null);

  const { data, loading, error, refetch } = useQuery<{ publications: Publication[] }>(
    `/publications${qs({ clientId: currentId })}`,
    [currentId],
  );

  return (
    <>
      <PageHeader
        title={t('nav.metaCampaigns')}
        subtitle={
          current
            ? `Advertisements for ${current.businessName}. Drafting is free; publishing spends the budget below.`
            : 'Choose a restaurant in the top bar to draft an advertisement for it.'
        }
        action={
          <Button icon={Plus} onClick={() => setDrafting(true)} disabled={!currentId}>
            New advertisement
          </Button>
        }
      />

      <Card>
        <CardHeader title="Advertisements" icon={Megaphone} />
        {error ? (
          <ErrorState message={error} onRetry={refetch} />
        ) : loading ? (
          <div className="p-4"><CardSkeleton rows={5} /></div>
        ) : (data?.publications.length ?? 0) === 0 ? (
          <EmptyState
            icon={Megaphone}
            title="No advertisements yet"
            body="Render a creative, then draft an advertisement around it. Nothing reaches Meta until you publish."
          />
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>{t('common.status')}</Th>
                <Th>Objective</Th>
                <Th align="end">Daily budget</Th>
                <Th>Flight</Th>
              </tr>
            </thead>
            <tbody>
              {data?.publications.map((row) => (
                <tr
                  key={row.id}
                  className="cursor-pointer hover:bg-elevated"
                  onClick={() => setReviewing(row.id)}
                >
                  <Td>
                    <span className="font-medium text-fg">{row.name}</span>
                    {row.providerAdId ? (
                      <span className="mt-0.5 block text-[11px] text-muted">Meta ad {row.providerAdId}</span>
                    ) : null}
                  </Td>
                  <Td>
                    <Badge tone={STATUS_TONES[row.status] ?? 'neutral'} dot>
                      {row.status.replace(/_/g, ' ').toLowerCase()}
                    </Badge>
                  </Td>
                  <Td>{row.objective.replace('OUTCOME_', '').toLowerCase()}</Td>
                  <Td align="end">
                    <span className="tabular">{money(Number(row.dailyBudget), lang)} {row.currency}</span>
                  </Td>
                  <Td>
                    <span className="text-muted">{date(row.startDate, lang)} → {date(row.endDate, lang)}</span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>

      <DraftModal open={drafting} clientId={currentId} onClose={() => setDrafting(false)} onCreated={refetch} />
      <ReviewDrawer id={reviewing} onClose={() => setReviewing(null)} onChanged={refetch} />
    </>
  );
}
