/**
 * Attaching real media to a piece of content.
 *
 * The distinction this component exists to enforce: it selects **media ids**,
 * not preview URLs. Content used to carry a URL string that lived only in React
 * state, so a post could look complete in the composer, save cleanly, and come
 * back from the database with nothing attached — which is what "Attach media to
 * preview the creative" was reporting on every screen downstream. An id is the
 * only thing that survives the round trip.
 *
 * Uploading and picking from the library are the same action here. Both end in
 * a Media row belonging to this client, and the caller only ever receives ids.
 */

import { useMemo, useRef, useState } from 'react';
import { Film, ImageOff, ImagePlus, Loader2, Trash2, Upload } from 'lucide-react';

import { api, qs, type MediaType } from '../lib/api';
import { useQuery } from '../lib/hooks';
import { Button, Card, CardHeader, CardSkeleton, useToast } from './ui';
import { cn } from '../lib/utils';
import { useI18n } from '../lib/i18n';

export interface PickedMedia {
  id: string;
  url: string;
  thumbnailUrl: string | null;
  type: MediaType;
  originalName: string;
  mimeType: string;
}

interface LibraryRow extends PickedMedia {
  clientId: string | null;
}

export function MediaPicker({
  clientId,
  campaignId,
  value,
  onChange,
  max = 10,
  title = 'Media / Creative',
  subtitle = 'What actually gets published. Uploads land in this project’s library.',
}: {
  clientId: string;
  campaignId?: string;
  /** Selected media ids, in publication order. */
  value: string[];
  onChange: (ids: string[], picked: PickedMedia[]) => void;
  max?: number;
  title?: string;
  subtitle?: string;
}) {
  const { push } = useToast();
  const { t } = useI18n();
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  // Bumped after an upload so the library refetches and shows the new file.
  const [libraryVersion, setLibraryVersion] = useState(0);

  const library = useQuery<{ items: LibraryRow[] }>(
    clientId ? `/media${qs({ clientId, pageSize: 60 })}` : null,
    [clientId, libraryVersion],
  );

  const rows = useMemo(() => library.data?.items ?? [], [library.data]);
  const byId = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);

  /** Selected rows, in the order the operator picked them — not library order. */
  const selected = useMemo(
    () => value.map((id) => byId.get(id)).filter((row): row is LibraryRow => Boolean(row)),
    [value, byId],
  );

  const emit = (ids: string[]) =>
    onChange(ids, ids.map((id) => byId.get(id)).filter((row): row is LibraryRow => Boolean(row)));

  const toggle = (id: string) => {
    if (value.includes(id)) {
      emit(value.filter((item) => item !== id));
      return;
    }
    if (value.length >= max) {
      push({ tone: 'info', title: `That is the maximum of ${max} for this post` });
      return;
    }
    emit([...value, id]);
  };

  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    if (!clientId) {
      push({ tone: 'error', title: t('common.pickProject') });
      return;
    }

    const form = new FormData();
    for (const file of Array.from(files).slice(0, max)) form.append('files', file);
    form.append('clientId', clientId);
    if (campaignId) form.append('campaignId', campaignId);

    setUploading(true);
    try {
      // The upload endpoint returns the rows it created, so the new files can be
      // selected immediately rather than after a round trip the operator has to
      // wait for and then hunt through the grid for.
      const result = await api.post<{ items: PickedMedia[] }>('/media', form);
      const fresh = result.items ?? [];
      setLibraryVersion((n) => n + 1);
      const ids = [...value, ...fresh.map((row) => row.id)].slice(0, max);
      onChange(ids, [...selected, ...fresh].slice(0, max));
      push({
        tone: 'success',
        title: `Attached ${fresh.length} file${fresh.length === 1 ? '' : 's'}`,
      });
    } catch (err) {
      push({ tone: 'error', title: 'Upload failed', body: err instanceof Error ? err.message : undefined });
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  return (
    <Card>
      <CardHeader
        title={title}
        subtitle={subtitle}
        icon={ImagePlus}
        action={
          <>
            <input
              ref={fileInput}
              type="file"
              accept="image/*,video/*"
              multiple
              className="hidden"
              onChange={(event) => void upload(event.target.files)}
            />
            <Button
              size="sm"
              variant="secondary"
              icon={Upload}
              loading={uploading}
              disabled={!clientId}
              onClick={() => fileInput.current?.click()}
            >
              Upload
            </Button>
          </>
        }
      />

      <div className="space-y-4 p-4">
        {/* What is attached right now, and in what order. */}
        {selected.length > 0 ? (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {selected.map((row, index) => (
              <figure key={row.id} className="group relative overflow-hidden rounded-xl border border-brand">
                {row.type === 'VIDEO' ? (
                  <video src={row.url} muted playsInline preload="metadata" className="aspect-square w-full object-cover" />
                ) : (
                  <img src={row.thumbnailUrl ?? row.url} alt={row.originalName} className="aspect-square w-full object-cover" />
                )}

                <span className="absolute start-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-brand text-[11px] font-medium text-white">
                  {index + 1}
                </span>

                <button
                  type="button"
                  aria-label={`Remove ${row.originalName}`}
                  onClick={() => toggle(row.id)}
                  className="absolute end-1 top-1 grid h-6 w-6 place-items-center rounded-full bg-black/55 text-white opacity-0 backdrop-blur-sm transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <Trash2 className="h-3 w-3" />
                </button>

                {row.type === 'VIDEO' ? (
                  <span className="pointer-events-none absolute bottom-1 end-1 rounded bg-black/55 p-1 text-white">
                    <Film className="h-3 w-3" />
                  </span>
                ) : null}
              </figure>
            ))}
          </div>
        ) : (
          <p className="flex items-center gap-2 rounded-xl border border-dashed border-line p-4 text-[13px] text-muted">
            <ImageOff className="h-4 w-4 shrink-0" />
            Nothing attached yet. Upload a file, or pick one from the library below.
          </p>
        )}

        {/* The library for this client. Selecting is how media is replaced. */}
        <div>
          <p className="mb-1.5 text-[11px] uppercase tracking-wide text-muted">
            {clientId ? 'From this project’s library' : t('common.pickProject')}
          </p>

          {!clientId ? null : library.loading ? (
            <CardSkeleton rows={2} />
          ) : rows.length === 0 ? (
            <p className="text-[13px] text-muted">
              This restaurant has no media yet. Upload the first file above.
            </p>
          ) : (
            <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
              {rows.map((row) => {
                const picked = value.includes(row.id);
                return (
                  <button
                    key={row.id}
                    type="button"
                    title={row.originalName}
                    onClick={() => toggle(row.id)}
                    className={cn(
                      'relative overflow-hidden rounded-lg border transition-colors',
                      picked ? 'border-brand' : 'border-line hover:border-brand/40',
                    )}
                  >
                    {row.type === 'VIDEO' ? (
                      <video src={row.url} muted playsInline preload="metadata" className="aspect-square w-full object-cover" />
                    ) : (
                      <img src={row.thumbnailUrl ?? row.url} alt={row.originalName} className="aspect-square w-full object-cover" />
                    )}
                    {picked ? <span className="absolute inset-0 bg-brand/20" /> : null}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {uploading ? (
          <p className="flex items-center gap-2 text-[12px] text-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Uploading…
          </p>
        ) : null}
      </div>
    </Card>
  );
}
