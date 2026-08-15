/**
 * Creative workflow for the AI Content Studio.
 *
 * Source asset first, then rendered artwork — the two are kept visibly
 * separate throughout, because they are separate things. The library panel and
 * the upload controls deal in *source* images; everything below the divider is
 * rendered output, one row per platform, each downloadable at that platform's
 * own dimensions.
 *
 * The download links are plain anchors to the API rather than blob fetches. The
 * server already sets `Content-Disposition`, and going through the anchor means
 * the browser streams the file straight to disk instead of the page holding a
 * multi-megabyte buffer in memory for every variant.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BadgeCheck, Check, Download, Image as ImageIcon, Layers, Library, Link2, RefreshCw,
  Sparkles, Trash2, TriangleAlert, Upload,
} from 'lucide-react';

import { api, qs, type Paginated, type Platform } from '../lib/api';
import { Badge, Button, Card, CardHeader, Field, Input, Modal, Spinner, useToast } from './ui';

// ---------------------------------------------------------------- types

interface MediaRow {
  id: string;
  originalName: string;
  url: string;
  width: number | null;
  height: number | null;
  mimeType: string;
  sizeBytes: number;
  type: string;
}

interface MatchCheck {
  key: string;
  label: string;
  weight: number;
  score: number | null;
  detail: string;
  advice?: string;
}

interface MatchResult {
  overall: number | null;
  band: 'EXCELLENT' | 'GOOD' | 'NEEDS_REVIEW' | 'POOR' | 'BLOCKED' | 'UNMEASURED';
  measured: number;
  checks: MatchCheck[];
  blockers: string[];
  recommendations: string[];
}

interface Preset {
  key: string;
  platform: Platform;
  label: string;
  width: number;
  height: number;
}

interface Creative {
  id: string;
  platform: Platform;
  preset: string;
  width: number;
  height: number;
  format: 'PNG' | 'JPG';
  url: string;
  sizeBytes: number;
  status: 'DRAFT' | 'SAVED' | 'APPROVED';
  match: MatchResult;
}

const BAND_TONE: Record<MatchResult['band'], { tone: 'ok' | 'warn' | 'danger' | 'neutral' | 'brand'; label: string }> = {
  EXCELLENT: { tone: 'ok', label: 'Ready for approval' },
  GOOD: { tone: 'ok', label: 'Ready for approval' },
  NEEDS_REVIEW: { tone: 'warn', label: 'Needs improvement' },
  POOR: { tone: 'danger', label: 'Needs improvement' },
  BLOCKED: { tone: 'danger', label: 'Blocked' },
  UNMEASURED: { tone: 'neutral', label: 'Analysis unavailable' },
};

// ---------------------------------------------------------------- component

export function CreativeStudio({
  clientId,
  campaignId,
  contentId,
  platform,
  headline,
  ctaLabel,
  onSourceChange,
}: {
  clientId: string;
  campaignId?: string;
  contentId?: string;
  platform: Platform;
  headline?: string | null;
  ctaLabel?: string | null;
  /** Lets the page show the same source in its own live preview. */
  onSourceChange?: (url: string | null) => void;
}) {
  const { push } = useToast();
  const fileInput = useRef<HTMLInputElement>(null);

  const [presets, setPresets] = useState<Preset[]>([]);
  const [source, setSource] = useState<MediaRow | null>(null);
  const [match, setMatch] = useState<MatchResult | null>(null);
  const [analysing, setAnalysing] = useState(false);
  const [creatives, setCreatives] = useState<Creative[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const [libraryOpen, setLibraryOpen] = useState(false);
  const [library, setLibrary] = useState<MediaRow[]>([]);
  const [urlOpen, setUrlOpen] = useState(false);
  const [importUrl, setImportUrl] = useState('');

  const presetFor = useCallback(
    (target: Platform) => presets.find((preset) => preset.platform === target) ?? presets[0],
    [presets],
  );

  useEffect(() => {
    api.get<{ presets: Preset[] }>('/creatives/presets').then((data) => setPresets(data.presets)).catch(() => undefined);
  }, []);

  // A new client means a different tenant's assets entirely; nothing carries over.
  useEffect(() => {
    setSource(null);
    setMatch(null);
    setCreatives([]);
    onSourceChange?.(null);
  }, [clientId]); // eslint-disable-line react-hooks/exhaustive-deps

  const analyse = useCallback(
    async (media: MediaRow) => {
      const preset = presetFor(platform);
      if (!preset) return;
      setAnalysing(true);
      try {
        const result = await api.post<{ match: MatchResult }>('/creatives/analyze', {
          mediaId: media.id,
          campaignId: campaignId || undefined,
          contentId: contentId || undefined,
          presetKey: preset.key,
          headline: headline ?? undefined,
          ctaLabel: ctaLabel ?? undefined,
        });
        setMatch(result.match);
      } catch (error) {
        // An analysis that failed is reported as unavailable, never as a score.
        setMatch(null);
        push({ tone: 'error', title: (error as Error).message });
      } finally {
        setAnalysing(false);
      }
    },
    [campaignId, contentId, ctaLabel, headline, platform, presetFor, push],
  );

  const attach = useCallback(
    async (media: MediaRow) => {
      setSource(media);
      setCreatives([]);
      onSourceChange?.(media.url);
      await analyse(media);
    },
    [analyse, onSourceChange],
  );

  useEffect(() => {
    if (source) void analyse(source);
    // Re-score when the placement or the copy changes — the score depends on both.
  }, [platform, headline, ctaLabel]); // eslint-disable-line react-hooks/exhaustive-deps

  async function upload(files: FileList | null) {
    if (!files?.length || !clientId) return;
    setBusy('upload');
    try {
      const form = new FormData();
      form.append('clientId', clientId);
      for (const file of Array.from(files)) form.append('files', file);

      const result = await api.post<{ items: MediaRow[] }>('/media', form);
      const first = result.items[0];
      if (first) await attach(first);
      push({ tone: 'success', title: 'Image uploaded' });
    } catch (error) {
      push({ tone: 'error', title: (error as Error).message });
    } finally {
      setBusy(null);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function importFromUrl() {
    if (!importUrl.trim() || !clientId) return;
    setBusy('url');
    try {
      const result = await api.post<{ media: MediaRow }>('/media/from-url', {
        url: importUrl.trim(),
        clientId,
      });
      setUrlOpen(false);
      setImportUrl('');
      await attach(result.media);
      push({ tone: 'success', title: 'Image imported' });
    } catch (error) {
      push({ tone: 'error', title: (error as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function openLibrary() {
    setLibraryOpen(true);
    try {
      const result = await api.get<Paginated<MediaRow>>(`/media${qs({ clientId, type: 'IMAGE', pageSize: 40 })}`);
      setLibrary(result.items);
    } catch (error) {
      push({ tone: 'error', title: (error as Error).message });
    }
  }

  async function render(all: boolean) {
    if (!source) return;
    const keys = all
      ? presets
          // One representative placement per platform for "all variants".
          .filter((preset, index, list) => list.findIndex((other) => other.platform === preset.platform) === index)
          .map((preset) => preset.key)
      : [presetFor(platform)?.key].filter(Boolean) as string[];

    if (keys.length === 0) return;
    setBusy('render');
    try {
      const result = await api.post<{ creatives: Creative[] }>('/creatives', {
        mediaId: source.id,
        campaignId: campaignId || undefined,
        contentId: contentId || undefined,
        presetKeys: keys,
        headline: headline ?? undefined,
        ctaLabel: ctaLabel ?? undefined,
      });
      setCreatives((current) => [...result.creatives, ...current]);
      push({ tone: 'success', title: `Rendered ${result.creatives.length} creative${result.creatives.length === 1 ? '' : 's'}` });
    } catch (error) {
      push({ tone: 'error', title: (error as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function setStatus(creative: Creative, status: Creative['status']) {
    try {
      const result = await api.patch<{ creative: Creative }>(`/creatives/${creative.id}`, { status });
      setCreatives((current) => current.map((item) => (item.id === creative.id ? { ...item, status: result.creative.status } : item)));
      push({ tone: 'success', title: status === 'APPROVED' ? 'Creative approved' : 'Creative saved' });
    } catch (error) {
      push({ tone: 'error', title: (error as Error).message });
    }
  }

  async function remove(creative: Creative) {
    try {
      await api.delete(`/creatives/${creative.id}`);
      setCreatives((current) => current.filter((item) => item.id !== creative.id));
    } catch (error) {
      push({ tone: 'error', title: (error as Error).message });
    }
  }

  const band = match ? BAND_TONE[match.band] : null;

  return (
    <Card>
      <CardHeader
        title="Creative"
        subtitle={source ? source.originalName : 'Attach a source image to render the post creative'}
        icon={ImageIcon}
        action={
          source ? (
            <Badge tone="neutral">
              {source.width}×{source.height}
            </Badge>
          ) : null
        }
      />

      <div className="space-y-4 p-5">
        {/* --- action bar ------------------------------------------------ */}
        <div className="flex flex-wrap gap-2">
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/avif"
            className="hidden"
            onChange={(event) => void upload(event.target.files)}
          />
          <Button variant="secondary" icon={Upload} onClick={() => fileInput.current?.click()} disabled={!clientId || busy === 'upload'}>
            {source ? 'Replace' : 'Upload image'}
          </Button>
          <Button variant="secondary" icon={Link2} onClick={() => setUrlOpen(true)} disabled={!clientId}>
            Image URL
          </Button>
          <Button variant="secondary" icon={Library} onClick={() => void openLibrary()} disabled={!clientId}>
            Media library
          </Button>
          {source ? (
            <>
              <Button icon={Sparkles} onClick={() => void render(false)} disabled={busy === 'render'}>
                {busy === 'render' ? 'Rendering…' : `Render ${presetFor(platform)?.label ?? 'creative'}`}
              </Button>
              <Button variant="secondary" icon={Layers} onClick={() => void render(true)} disabled={busy === 'render'}>
                All variants
              </Button>
              <Button variant="ghost" icon={RefreshCw} onClick={() => void analyse(source)} disabled={analysing}>
                Re-analyse
              </Button>
            </>
          ) : null}
        </div>

        {!clientId ? <p className="text-[13px] text-muted">Pick a client first — assets belong to one client and are never shared.</p> : null}

        {/* --- source + analysis ----------------------------------------- */}
        {source ? (
          <div className="grid gap-4 md:grid-cols-[200px_minmax(0,1fr)]">
            <div className="overflow-hidden rounded-xl border border-line bg-elevated">
              <img src={source.url} alt={source.originalName} className="aspect-square w-full object-cover" />
              <p className="border-t border-line px-2.5 py-1.5 text-[11px] text-muted">Source asset</p>
            </div>

            <div>
              {analysing ? (
                <div className="flex items-center gap-2 text-[13px] text-muted">
                  <Spinner className="h-4 w-4" /> Analysing creative…
                </div>
              ) : !match ? (
                <p className="text-[13px] text-muted">Image analysis unavailable.</p>
              ) : (
                <>
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    <span className="text-2xl font-semibold tabular-nums">
                      {match.overall === null ? '—' : `${match.overall}`}
                      <span className="text-[13px] font-normal text-muted">/100</span>
                    </span>
                    {band ? <Badge tone={band.tone}>{band.label}</Badge> : null}
                    <span className="text-[11px] text-muted">{Math.round(match.measured * 100)}% of checks measurable</span>
                  </div>

                  <ul className="space-y-1.5">
                    {match.checks.map((check) => (
                      <li key={check.key} className="flex items-baseline justify-between gap-3 text-[13px]">
                        <span className="text-muted">{check.label}</span>
                        <span className="flex items-center gap-2">
                          <span className="tabular-nums">
                            {check.score === null ? (
                              <span className="text-[11px] uppercase tracking-wide text-muted/70" title={check.detail}>
                                Unavailable
                              </span>
                            ) : (
                              `${check.score}%`
                            )}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>

                  {match.blockers.length > 0 ? (
                    <div className="mt-3 rounded-lg border border-danger/25 bg-danger/10 p-3">
                      {match.blockers.map((blocker) => (
                        <p key={blocker} className="flex gap-2 text-[12px] text-fg">
                          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" /> {blocker}
                        </p>
                      ))}
                    </div>
                  ) : null}

                  {match.recommendations.length > 0 ? (
                    <ul className="mt-3 space-y-1">
                      {match.recommendations.map((line) => (
                        <li key={line} className="text-[12px] text-muted">• {line}</li>
                      ))}
                    </ul>
                  ) : null}
                </>
              )}
            </div>
          </div>
        ) : null}

        {/* --- rendered variants ----------------------------------------- */}
        {creatives.length > 0 ? (
          <div className="space-y-2 border-t border-line pt-4">
            <p className="text-[11px] uppercase tracking-wide text-muted">Rendered creatives</p>
            {creatives.map((creative) => (
              <div key={creative.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-elevated p-3">
                <img src={creative.url} alt="" className="h-16 w-16 rounded-lg object-cover ring-1 ring-line" />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium">{creative.preset.replace(/_/g, ' ').toLowerCase()}</p>
                  <p className="text-[11px] text-muted">
                    {creative.width}×{creative.height} · {(creative.sizeBytes / 1024).toFixed(0)} KB
                    {creative.match?.overall !== null && creative.match?.overall !== undefined ? ` · ${creative.match.overall}/100` : ''}
                  </p>
                </div>
                <Badge tone={creative.status === 'APPROVED' ? 'ok' : creative.status === 'SAVED' ? 'brand' : 'neutral'}>
                  {creative.status}
                </Badge>
                <div className="flex flex-wrap gap-1.5">
                  {/* Plain anchors: the server sets Content-Disposition, so the
                      browser streams straight to disk. */}
                  <a
                    className="rounded-lg border border-line px-2.5 py-1 text-[12px] font-medium hover:border-brand/40"
                    href={`/api/creatives/${creative.id}/download?format=PNG`}
                  >
                    PNG
                  </a>
                  <a
                    className="rounded-lg border border-line px-2.5 py-1 text-[12px] font-medium hover:border-brand/40"
                    href={`/api/creatives/${creative.id}/download?format=JPG`}
                  >
                    JPG
                  </a>
                  <Button variant="ghost" icon={Check} onClick={() => void setStatus(creative, 'SAVED')}>
                    Save
                  </Button>
                  <Button variant="ghost" icon={BadgeCheck} onClick={() => void setStatus(creative, 'APPROVED')}>
                    Approve
                  </Button>
                  <Button variant="ghost" icon={Trash2} onClick={() => void remove(creative)}>
                    <span className="sr-only">Delete</span>
                  </Button>
                </div>
              </div>
            ))}
            {creatives.length > 1 ? (
              <p className="pt-1 text-[11px] text-muted">
                <Download className="mb-0.5 inline h-3 w-3" /> Each variant downloads at its own platform dimensions.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* --- media library --------------------------------------------- */}
      <Modal open={libraryOpen} onClose={() => setLibraryOpen(false)} title="Media library">
        {library.length === 0 ? (
          <p className="p-4 text-[13px] text-muted">No images for this client yet.</p>
        ) : (
          <div className="grid max-h-[60vh] grid-cols-3 gap-2 overflow-y-auto p-1 sm:grid-cols-4">
            {library.map((item) => (
              <button
                key={item.id}
                type="button"
                className="overflow-hidden rounded-lg border border-line hover:border-brand/50"
                onClick={() => {
                  setLibraryOpen(false);
                  void attach(item);
                }}
              >
                <img src={item.url} alt={item.originalName} className="aspect-square w-full object-cover" />
              </button>
            ))}
          </div>
        )}
      </Modal>

      {/* --- import by URL ---------------------------------------------- */}
      <Modal
        open={urlOpen}
        onClose={() => setUrlOpen(false)}
        title="Import image from URL"
        footer={
          <Button onClick={() => void importFromUrl()} disabled={busy === 'url'}>
            {busy === 'url' ? 'Importing…' : 'Import'}
          </Button>
        }
      >
        <Field label="Image URL" hint="The image is downloaded and stored, so the creative does not depend on the source staying online.">
          <Input
            value={importUrl}
            onChange={(event) => setImportUrl(event.target.value)}
            placeholder="https://example.com/photo.jpg"
          />
        </Field>
      </Modal>
    </Card>
  );
}
