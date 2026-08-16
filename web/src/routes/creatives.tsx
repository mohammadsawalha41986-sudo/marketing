/**
 * Creatives — upload the finished ad, and find out where it can run.
 *
 * This is the front door of the product. The operator made the advertisement in
 * Canva, Photoshop, CapCut or on their phone; this page takes that file as the
 * ad. It does not offer to render one, and it never alters what was uploaded.
 *
 * The validation matrix is the reason the page exists. "Invalid" on its own
 * sends someone back to their design tool guessing; every row here states what
 * the file *is* and what the placement *needs*, so the fix is obvious before
 * they reopen anything.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2, CircleHelp, FileWarning, Image as ImageIcon, Upload, XCircle,
} from 'lucide-react';

import { api, type Platform } from '../lib/api';
import { useQuery } from '../lib/hooks';
import { useI18n } from '../lib/i18n';
import { useRestaurant } from '../lib/restaurant';
import { bytes, cn } from '../lib/utils';
import { relative } from '../lib/format';
import {
  Badge, Button, Card, CardHeader, CardSkeleton, EmptyState, PageHeader, Spinner, useToast,
} from '../components/ui';
import { PlatformChip } from '../components/domain';

type Outcome = 'VALID' | 'INVALID' | 'UNKNOWN';

interface PlacementCheck {
  key: string;
  label: string;
  outcome: Outcome;
  actual: string;
  required: string;
  reason: string;
}

interface PlacementValidation {
  placement: string;
  platform: Platform;
  label: string;
  surface: string;
  outcome: Outcome;
  checks: PlacementCheck[];
  blockingReason: string | null;
  sourceUrl: string;
  verifiedAt: string;
}

interface Inspected {
  kind: 'IMAGE' | 'VIDEO';
  sha256: string;
  sizeBytes: number;
  format: string;
  width: number | null;
  height: number | null;
  aspectRatio: number | null;
  durationSeconds: number | null;
  frameRate: number | null;
  videoCodec: string | null;
  hasAudio: boolean | null;
  measured: boolean;
  note: string | null;
}

interface UploadResult {
  creative: { id: string; url: string; source: string; platform: Platform };
  media: { id: string; originalName: string };
  inspected: Inspected;
  validation: { valid: number; invalid: number; unknown: number; placements: PlacementValidation[] };
  duplicateOf: { id: string; originalName: string; uploadedAt: string } | null;
}

interface CreativeRow {
  id: string;
  clientId: string;
  platform: Platform;
  preset: string;
  source: string;
  width: number;
  height: number;
  url: string;
  sizeBytes: number;
  status: string;
  createdAt: string;
}

const OUTCOME_ICON = { VALID: CheckCircle2, INVALID: XCircle, UNKNOWN: CircleHelp } as const;
const OUTCOME_CLASS = { VALID: 'text-ok', INVALID: 'text-danger', UNKNOWN: 'text-muted' } as const;

/** One placement, expandable to the checks behind the verdict. */
function PlacementRow({ row }: { row: PlacementValidation }) {
  const [open, setOpen] = useState(false);
  const Icon = OUTCOME_ICON[row.outcome];

  return (
    <div className="border-b border-line/60 last:border-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-3 px-4 py-3 text-start transition-colors hover:bg-elevated"
      >
        <Icon className={cn('h-4 w-4 shrink-0', OUTCOME_CLASS[row.outcome])} />
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium text-fg">{row.label}</span>
          <span className="block truncate text-[12px] text-muted">
            {row.blockingReason ?? (row.outcome === 'UNKNOWN' ? 'Some checks could not be measured.' : 'Ready to run here.')}
          </span>
        </span>
        <PlatformChip platform={row.platform} size="sm" />
      </button>

      {open ? (
        <div className="space-y-1.5 bg-elevated/60 px-4 pb-3 pt-1">
          {row.checks.map((check) => (
            <div key={check.key} className="flex items-baseline justify-between gap-3 text-[12px]">
              <span className="text-muted">{check.label}</span>
              <span className="text-end">
                <span className={cn('font-medium', OUTCOME_CLASS[check.outcome])}>{check.actual}</span>
                <span className="text-muted"> · needs {check.required}</span>
              </span>
            </div>
          ))}
          <p className="pt-1 text-[11px] text-muted/80">
            Spec checked {row.verifiedAt} ·{' '}
            <a href={row.sourceUrl} target="_blank" rel="noreferrer" className="text-brand hover:underline">
              source
            </a>
          </p>
        </div>
      ) : null}
    </div>
  );
}

export function CreativesPage() {
  const { t, lang } = useI18n();
  const { push } = useToast();
  const { current, currentId } = useRestaurant();

  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [uploadedAt, setUploadedAt] = useState(0);

  const { data, loading } = useQuery<{ creatives: CreativeRow[] }>('/creatives', [uploadedAt]);

  const mine = useMemo(
    () => (data?.creatives ?? []).filter((row) => !currentId || row.clientId === currentId),
    [data, currentId],
  );

  const upload = useCallback(
    async (file: File) => {
      if (!currentId) {
        push({ tone: 'error', title: 'Choose a restaurant in the top bar first' });
        return;
      }

      setUploading(true);
      try {
        const body = new FormData();
        body.append('file', file);
        body.append('clientId', currentId);

        const response = await api.post<UploadResult>('/creatives/upload', body);
        setResult(response);
        setUploadedAt(Date.now());

        if (response.duplicateOf) {
          push({
            tone: 'info',
            title: 'You already had this file',
            body: `Identical to ${response.duplicateOf.originalName}. The asset was reused rather than stored twice.`,
          });
        } else {
          push({ tone: 'success', title: 'Uploaded', body: 'Nothing was resized or re-encoded.' });
        }
      } catch (err) {
        push({ tone: 'error', title: 'Upload failed', body: err instanceof Error ? err.message : undefined });
      } finally {
        setUploading(false);
      }
    },
    [currentId, push],
  );

  const inspected = result?.inspected;

  return (
    <>
      <PageHeader
        title={t('nav.creatives')}
        subtitle={
          current
            ? `You make the ad. Upload the finished file for ${current.businessName} — it runs exactly as you made it.`
            : 'Choose a restaurant in the top bar, then upload the finished advertisement.'
        }
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-4">
          {/* --- the drop zone ------------------------------------------- */}
          <Card>
            <div
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                const file = event.dataTransfer.files[0];
                if (file) void upload(file);
              }}
              className={cn(
                'flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed p-10 text-center transition-colors',
                dragging ? 'border-brand bg-brand/5' : 'border-line',
              )}
            >
              <input
                ref={fileRef}
                type="file"
                accept="image/jpeg,image/png,video/mp4,video/quicktime"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void upload(file);
                  event.target.value = '';
                }}
              />

              <span className="grid h-12 w-12 place-items-center rounded-2xl bg-brand/10 text-brand">
                {uploading ? <Spinner className="h-5 w-5" /> : <Upload className="h-5 w-5" />}
              </span>

              <div>
                <p className="text-sm font-medium text-fg">{t('creative.dropHere')}</p>
                <p className="mt-1 text-[13px] text-muted">JPG · PNG · MP4 · MOV</p>
              </div>

              <Button onClick={() => fileRef.current?.click()} loading={uploading} disabled={!currentId}>
                {t('common.upload')}
              </Button>

              <p className="max-w-md text-[12px] leading-relaxed text-muted">
                {t('creative.uploadNote')}
              </p>
            </div>
          </Card>

          {/* --- what the file is ---------------------------------------- */}
          {inspected ? (
            <Card>
              <CardHeader
                title={t('creative.fileReading')}
                subtitle={result?.media.originalName}
                icon={ImageIcon}
              />
              <div className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-4">
                {[
                  ['Format', inspected.format.toUpperCase()],
                  ['Dimensions', inspected.width && inspected.height ? `${inspected.width} × ${inspected.height}` : 'not measured'],
                  ['Aspect ratio', inspected.aspectRatio ? `${inspected.aspectRatio.toFixed(2)}:1` : 'not measured'],
                  ['File size', bytes(inspected.sizeBytes)],
                  ...(inspected.kind === 'VIDEO'
                    ? ([
                        ['Duration', inspected.durationSeconds ? `${inspected.durationSeconds.toFixed(1)}s` : 'not measured'],
                        ['Frame rate', inspected.frameRate ? `${inspected.frameRate} fps` : 'not measured'],
                        ['Codec', inspected.videoCodec ?? 'not measured'],
                        ['Audio', inspected.hasAudio === null ? 'not measured' : inspected.hasAudio ? 'yes' : 'none'],
                      ] as Array<[string, string]>)
                    : []),
                ].map(([label, value]) => (
                  <div key={label} className="rounded-xl border border-line bg-elevated p-3">
                    <p className="text-[11px] uppercase tracking-wide text-muted">{label}</p>
                    <p className="mt-0.5 text-[13px] font-medium text-fg">{value}</p>
                  </div>
                ))}
              </div>

              {inspected.note ? (
                <div className="mx-5 mb-5 flex items-start gap-2 rounded-xl border border-warn/25 bg-warn/10 p-3 text-[12px] text-fg">
                  <FileWarning className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />
                  <span>{inspected.note}</span>
                </div>
              ) : null}
            </Card>
          ) : null}

          {/* --- where it can run ---------------------------------------- */}
          {result ? (
            <Card>
              <CardHeader
                title={t('creative.placements')}
                subtitle={`${result.validation.valid} valid · ${result.validation.invalid} not valid · ${result.validation.unknown} unmeasured`}
              />
              <div>
                {result.validation.placements.map((row) => (
                  <PlacementRow key={row.placement} row={row} />
                ))}
              </div>
              <p className="border-t border-line px-4 py-3 text-[12px] leading-relaxed text-muted">
                {t('creative.noResizeNote')}
              </p>
            </Card>
          ) : null}
        </div>

        {/* --- the library ---------------------------------------------- */}
        <Card className="h-fit">
          <CardHeader title={t('creative.library')} icon={ImageIcon} />
          {loading ? (
            <div className="p-4"><CardSkeleton rows={4} /></div>
          ) : mine.length === 0 ? (
            <EmptyState
              icon={Upload}
              title={t('creative.emptyTitle')}
              body={t('creative.emptyBody')}
            />
          ) : (
            <div className="divide-y divide-line/60">
              {mine.slice(0, 24).map((creative) => (
                <div key={creative.id} className="flex items-center gap-3 p-3">
                  <img
                    src={creative.url}
                    alt=""
                    className="h-14 w-14 shrink-0 rounded-lg bg-elevated object-cover ring-1 ring-line"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium text-fg">
                      {creative.source === 'UPLOADED' ? 'Uploaded ad' : creative.preset.replace(/_/g, ' ').toLowerCase()}
                    </p>
                    <p className="text-[11px] text-muted">
                      {creative.width || '?'}×{creative.height || '?'} · {bytes(creative.sizeBytes)} ·{' '}
                      {relative(creative.createdAt, lang)}
                    </p>
                    <div className="mt-1 flex items-center gap-1.5">
                      <PlatformChip platform={creative.platform} size="sm" />
                      <Badge tone={creative.source === 'UPLOADED' ? 'brand' : 'neutral'}>
                        {creative.source.toLowerCase()}
                      </Badge>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
