/**
 * The Report Builder: configuration on the left, the real report on the right.
 *
 * The preview is not a mock-up of the report — it *is* the report, the same
 * `ReportPreview` the print stylesheet lays out onto pages. So an operator
 * never has to export a PDF to find out what a change did, and the PDF can
 * never disagree with what they approved.
 *
 * Every configuration change re-asks the server, debounced, through
 * `POST /reports/builder/preview`. That endpoint computes from Phase 14 exactly
 * as the saved report does, so an unsaved draft and a saved report cannot show
 * different numbers for the same configuration — which is the failure mode of
 * previewing from a client-side model instead.
 *
 * Export is `window.print()`. The project has no PDF library, and adding a
 * headless browser to render one document would be a large dependency and a
 * second renderer to keep in sync. The print stylesheet does the work, and the
 * browser's own PDF writer handles Arabic shaping and RTL correctly, which is
 * the part a hand-rolled generator would most likely get wrong.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Copy, FileText, Printer, Save, Trash2 } from 'lucide-react';

import { api, qs, type Paginated, type Platform } from '../lib/api';
import { useQuery, useDebounced } from '../lib/hooks';
import { useI18n, type TranslationKey } from '../lib/i18n';
import { useRestaurant } from '../lib/restaurant';
import { PLATFORM_LABELS, humanize } from '../lib/format';
import { cn } from '../lib/utils';
import {
  Button, Card, CardSkeleton, EmptyState, ErrorState, Field, Input, PageHeader,
  Textarea, useToast,
} from '../components/ui';
import { ReportPreview } from '../components/report-preview';
import { WORKSPACE_PLATFORMS } from '../lib/workspace-content';
import {
  DEFAULT_CONFIG, PERIOD_PRESETS, REPORT_METRICS, REPORT_SECTIONS,
  type BuilderReportRow, type ReportConfig, type ReportData, type ReportMetric,
  type ReportSection,
} from '../lib/report-types';

const isoDay = (value: Date) => value.toISOString().slice(0, 10);

function presetRange(days: number): { start: string; end: string } {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - days);
  return { start: isoDay(start), end: isoDay(end) };
}

/** A row of toggles that reads as one control rather than a column of boxes. */
function ChipGroup<T extends string>({
  options, selected, onToggle, labelFor,
}: {
  options: readonly T[];
  selected: T[];
  onToggle: (value: T) => void;
  labelFor: (value: T) => string;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((option) => {
        const active = selected.includes(option);
        return (
          <button
            key={option}
            type="button"
            aria-pressed={active}
            onClick={() => onToggle(option)}
            className={cn(
              'rounded-full border px-2.5 py-1 text-[12px] transition-colors',
              active
                ? 'border-brand bg-brand/12 font-medium text-brand'
                : 'border-line text-muted hover:text-fg',
            )}
          >
            {labelFor(option)}
          </button>
        );
      })}
    </div>
  );
}

export function ReportBuilderPage() {
  const { id } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const { currentId: clientId, current } = useRestaurant();
  const { t } = useI18n();
  const { push } = useToast();

  const editing = Boolean(id);
  const saved = useQuery<{ report: BuilderReportRow }>(id ? `/reports/${id}` : null, [id]);

  const [title, setTitle] = useState('');
  const [config, setConfig] = useState<ReportConfig>({ ...DEFAULT_CONFIG });
  const [preset, setPreset] = useState('30');
  const [range, setRange] = useState(() => presetRange(30));
  const [saving, setSaving] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  // Seed from the saved row exactly once. Re-seeding on every refetch would
  // discard edits the moment anything else in the page refreshed.
  useEffect(() => {
    const report = saved.data?.report;
    if (!report || hydrated) return;
    setTitle(report.title);
    setConfig({ ...DEFAULT_CONFIG, ...(report.payload?.builder ?? {}) } as ReportConfig);
    setRange({ start: report.periodStart.slice(0, 10), end: report.periodEnd.slice(0, 10) });
    setPreset('custom');
    setHydrated(true);
  }, [saved.data, hydrated]);

  const effectiveClientId = saved.data?.report.client.id ?? clientId;

  const applyPreset = (key: string) => {
    setPreset(key);
    const days = PERIOD_PRESETS.find((entry) => entry.key === key)?.days;
    if (days) setRange(presetRange(days));
  };

  const toggle = <T extends string>(list: T[], value: T): T[] =>
    list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];

  // Debounced so dragging a date or clicking through platforms does not fire a
  // request per keystroke.
  const previewKey = useDebounced(
    JSON.stringify({ effectiveClientId, range, config }),
    350,
  );

  const [preview, setPreview] = useState<{ data: ReportData } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const loadPreview = useCallback(async () => {
    if (!effectiveClientId || !range.start || !range.end) return;
    setPreviewing(true);
    setPreviewError(null);
    try {
      const response = await api.post<{ data: ReportData }>('/reports/builder/preview', {
        clientId: effectiveClientId,
        title: title.trim() || t('report.untitled'),
        periodStart: range.start,
        periodEnd: range.end,
        description: config.description,
        platforms: config.platforms,
        metrics: config.metrics,
        sections: config.sections,
      });
      setPreview(response);
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : 'Preview failed');
    } finally {
      setPreviewing(false);
    }
    // `title` is deliberately absent from the dependency list: it appears in the
    // preview header, which is rendered locally, and re-fetching the figures on
    // every keystroke of the name would be a request per character.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey]);

  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);

  const body = useMemo(() => ({
    clientId: effectiveClientId,
    title: title.trim(),
    periodStart: range.start,
    periodEnd: range.end,
    description: config.description,
    platforms: config.platforms,
    metrics: config.metrics,
    sections: config.sections,
  }), [effectiveClientId, title, range, config]);

  const save = async () => {
    if (!body.clientId || !body.title) return;
    setSaving(true);
    try {
      if (editing) {
        const { clientId: _omit, ...patch } = body;
        await api.patch(`/reports/builder/${id}`, patch);
        push({ tone: 'success', title: t('report.saved') });
      } else {
        const created = await api.post<{ report: { id: string } }>('/reports/builder', body);
        push({ tone: 'success', title: t('report.saved') });
        navigate(`/app/reports/builder/${created.report.id}`);
      }
    } catch (error) {
      push({
        tone: 'error',
        title: t('report.saveFailed'),
        body: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  };

  const duplicate = async () => {
    if (!id) return;
    try {
      const copy = await api.post<{ report: { id: string } }>(`/reports/builder/${id}/duplicate`, {});
      push({ tone: 'success', title: t('report.duplicated') });
      navigate(`/app/reports/builder/${copy.report.id}`);
    } catch (error) {
      push({ tone: 'error', title: t('report.duplicateFailed'), body: error instanceof Error ? error.message : undefined });
    }
  };

  const remove = async () => {
    if (!id) return;
    try {
      await api.delete(`/reports/${id}`);
      push({ tone: 'success', title: t('report.deleted') });
      navigate('/app/reports');
    } catch (error) {
      push({ tone: 'error', title: t('report.deleteFailed'), body: error instanceof Error ? error.message : undefined });
    }
  };

  const clientName = saved.data?.report.client.businessName
    ?? saved.data?.report.client.name
    ?? current?.businessName
    ?? '';

  if (editing && saved.loading) return <CardSkeleton rows={6} />;
  if (editing && saved.error) return <Card><ErrorState message={saved.error} onRetry={saved.refetch} /></Card>;

  if (!effectiveClientId) {
    return (
      <EmptyState
        icon={FileText}
        title={t('library.pickRestaurantTitle')}
        body={t('library.pickRestaurant')}
      />
    );
  }

  return (
    <>
      {/* The whole chrome is hidden when printing; only .report-sheet survives. */}
      <div className="print:hidden">
        <PageHeader
          title={editing ? t('report.editTitle') : t('report.newTitle')}
          subtitle={clientName}
          action={
            <>
              {editing ? (
                <>
                  <Button variant="secondary" icon={Copy} onClick={duplicate}>{t('library.duplicate')}</Button>
                  <Button variant="secondary" icon={Trash2} onClick={remove}>{t('common.delete')}</Button>
                </>
              ) : null}
              <Button variant="secondary" icon={Printer} onClick={() => window.print()}>
                {t('report.exportPdf')}
              </Button>
              <Button icon={Save} loading={saving} disabled={!title.trim()} onClick={save}>
                {t('common.save')}
              </Button>
            </>
          }
        />
      </div>

      <div className="report-builder-grid grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        {/* ------------------------------------------------- configuration */}
        <aside className="space-y-3 print:hidden">
          <Card className="p-3.5">
            <Field label={t('report.name')} required>
              <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t('report.untitled')} />
            </Field>

            <Field label={t('report.description')} className="mt-3">
              <Textarea
                rows={2}
                value={config.description ?? ''}
                onChange={(event) => setConfig((c) => ({ ...c, description: event.target.value || null }))}
              />
            </Field>
          </Card>

          <Card className="p-3.5">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">{t('report.period')}</p>
            <ChipGroup
              options={PERIOD_PRESETS.map((entry) => entry.key)}
              selected={[preset]}
              onToggle={applyPreset}
              labelFor={(key) => t(`report.preset.${key}` as TranslationKey)}
            />
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Field label={t('report.start')}>
                <Input
                  type="date"
                  value={range.start}
                  onChange={(event) => { setPreset('custom'); setRange((r) => ({ ...r, start: event.target.value })); }}
                />
              </Field>
              <Field label={t('report.end')}>
                <Input
                  type="date"
                  value={range.end}
                  onChange={(event) => { setPreset('custom'); setRange((r) => ({ ...r, end: event.target.value })); }}
                />
              </Field>
            </div>
          </Card>

          <Card className="p-3.5">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">{t('common.platform')}</p>
            <ChipGroup
              options={WORKSPACE_PLATFORMS}
              selected={config.platforms}
              onToggle={(platform) => setConfig((c) => ({ ...c, platforms: toggle(c.platforms, platform as Platform) }))}
              labelFor={(platform) => PLATFORM_LABELS[platform] ?? humanize(platform)}
            />
            <p className="mt-1.5 text-[11px] text-muted">{t('report.platformsHint')}</p>
          </Card>

          <Card className="p-3.5">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">{t('report.kpis')}</p>
            <ChipGroup
              options={REPORT_METRICS}
              selected={config.metrics}
              onToggle={(metric) => setConfig((c) => ({ ...c, metrics: toggle(c.metrics, metric as ReportMetric) }))}
              labelFor={(metric) => t(`report.metric.${metric}` as TranslationKey)}
            />
          </Card>

          <Card className="p-3.5">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">{t('report.sections')}</p>
            <ChipGroup
              options={REPORT_SECTIONS}
              selected={config.sections}
              onToggle={(section) => setConfig((c) => ({ ...c, sections: toggle(c.sections, section as ReportSection) }))}
              labelFor={(section) => t(`report.section.${section}` as TranslationKey)}
            />
          </Card>
        </aside>

        {/* -------------------------------------------------------- preview */}
        <div className="min-w-0">
          <Card className="p-4 sm:p-6 print:border-0 print:bg-transparent print:p-0 print:shadow-none">
            {previewError ? (
              <ErrorState message={previewError} onRetry={() => void loadPreview()} />
            ) : !preview ? (
              <CardSkeleton rows={6} />
            ) : (
              <div className={cn('transition-opacity', previewing && 'opacity-60')}>
                <ReportPreview
                  title={title.trim() || t('report.untitled')}
                  clientName={clientName}
                  clientLogoUrl={saved.data?.report.client.logoUrl ?? current?.logoUrl}
                  description={config.description}
                  data={preview.data}
                  sections={config.sections}
                />
              </div>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

// ------------------------------------------------------------------- list

export function ReportBuilderListPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search, 250);

  const { data, loading, error, refetch } = useQuery<Paginated<BuilderReportRow>>(
    `/reports${qs({ type: 'BUILDER', pageSize: 50 })}`,
    [],
  );

  const rows = useMemo(() => {
    const items = data?.items ?? [];
    if (!debounced) return items;
    const needle = debounced.toLowerCase();
    return items.filter((row) =>
      row.title.toLowerCase().includes(needle)
      || (row.client?.businessName ?? row.client?.name ?? '').toLowerCase().includes(needle));
  }, [data, debounced]);

  return (
    <>
      <PageHeader
        title={t('report.buildersTitle')}
        subtitle={t('report.buildersSubtitle')}
        action={
          <Button icon={FileText} onClick={() => navigate('/app/reports/builder')}>
            {t('report.newTitle')}
          </Button>
        }
      />

      <Card className="mb-3 p-2.5">
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t('common.search')}
          aria-label={t('common.search')}
        />
      </Card>

      {loading ? (
        <CardSkeleton rows={4} />
      ) : error ? (
        <ErrorState message={error} onRetry={refetch} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={FileText}
          title={t('report.emptyTitle')}
          body={t('report.emptyBody')}
          action={<Button icon={FileText} onClick={() => navigate('/app/reports/builder')}>{t('report.newTitle')}</Button>}
        />
      ) : (
        <div className="space-y-2">
          {rows.map((row) => (
            <Card
              key={row.id}
              className="cursor-pointer p-3.5 transition-colors hover:border-brand/40"
              onClick={() => navigate(`/app/reports/builder/${row.id}`)}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-[14px] font-semibold" dir="auto">{row.title}</p>
                  <p className="mt-0.5 text-[12px] text-muted" dir="auto">
                    {row.client?.businessName ?? row.client?.name}
                  </p>
                </div>
                <p className="text-[11.5px] text-muted" dir="ltr">
                  {row.periodStart.slice(0, 10)} — {row.periodEnd.slice(0, 10)}
                </p>
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
