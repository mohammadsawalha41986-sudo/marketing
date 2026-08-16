/** Brand DNA editor, logo upload, and the suggested-identity approval flow. */

import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Check, Palette, Sparkles, Upload, Wand2 } from 'lucide-react';

import { api, qs, type Language, type Paginated } from '../lib/api';
import { useQuery } from '../lib/hooks';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import {
  Badge, Button, Card, CardHeader, CardSkeleton, EmptyState, ErrorState, Field, Input,
  PageHeader, Select, Tabs, Textarea, useToast,
} from '../components/ui';
import { Swatch } from '../components/domain';
import { ContentPreview } from '../components/content-preview';

interface SuggestedPalette {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  text: string;
  fontFamily: string;
  visualStyle: string;
  contrast: number;
  swatches: Array<{ hex: string; weight: number }>;
  notes: string[];
}

interface Brand {
  id: string;
  clientId: string;
  businessName: string;
  businessType: string | null;
  industry: string | null;
  description: string | null;
  targetAudience: string | null;
  location: string | null;
  personality: string[];
  toneOfVoice: string | null;
  values: string[];
  products: string[];
  services: string[];
  usps: string[];
  offers: string[];
  keywords: string[];
  forbiddenWords: string[];
  ctaStyle: string | null;
  preferredLanguage: Language;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  backgroundColor: string;
  textColor: string;
  fontFamily: string;
  logoUrl: string | null;
  suggestedPalette: SuggestedPalette | null;
  paletteApproved: boolean;
}

/** Comma-separated text ↔ string[] so lists stay easy to edit. */
function ListField({
  label, hint, value, onChange,
}: { label: string; hint?: string; value: string[]; onChange: (value: string[]) => void }) {
  const [text, setText] = useState(value.join(', '));
  useEffect(() => setText(value.join(', ')), [value]);

  return (
    <Field label={label} hint={hint ?? 'Separate with commas'}>
      <Input
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => onChange(text.split(',').map((item) => item.trim()).filter(Boolean))}
      />
    </Field>
  );
}

export function BrandPage({ portal = false }: { portal?: boolean }) {
  const { t } = useI18n();
  const { user, isAgency } = useAuth();
  const { push } = useToast();
  const [params, setParams] = useSearchParams();
  const fileRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<'dna' | 'identity'>('dna');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [draft, setDraft] = useState<Brand | null>(null);

  const clients = useQuery<Paginated<{ id: string; name: string }>>(
    portal ? null : `/clients${qs({ pageSize: 100 })}`,
  );

  const clientId = portal ? user?.clientId ?? '' : params.get('client') ?? clients.data?.items[0]?.id ?? '';
  const { data, loading, error, refetch } = useQuery<{ brand: Brand }>(clientId ? `/brands/${clientId}` : null, [clientId]);

  useEffect(() => {
    if (data?.brand) setDraft(data.brand);
  }, [data]);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const { id: _id, clientId: _clientId, logoUrl: _logo, suggestedPalette: _suggested, paletteApproved: _approved, ...payload } = draft;
      await api.patch(`/brands/${clientId}`, payload);
      push({ tone: 'success', title: 'Brand DNA saved' });
      refetch();
    } catch (err) {
      push({ tone: 'error', title: 'Could not save', body: err instanceof Error ? err.message : undefined });
    } finally {
      setSaving(false);
    }
  };

  const uploadLogo = async (file: File) => {
    setUploading(true);
    try {
      const body = new FormData();
      body.append('file', file);
      const response = await api.post<{ suggested: SuggestedPalette }>(`/brands/${clientId}/logo`, body);
      push({
        tone: 'success',
        title: 'Logo uploaded',
        body: `Suggested a ${response.suggested.visualStyle.toLowerCase()} palette. Review and approve it.`,
      });
      setTab('identity');
      refetch();
    } catch (err) {
      push({ tone: 'error', title: 'Upload failed', body: err instanceof Error ? err.message : undefined });
    } finally {
      setUploading(false);
    }
  };

  const applySuggestion = () => {
    if (!draft?.suggestedPalette) return;
    const suggested = draft.suggestedPalette;
    setDraft({
      ...draft,
      primaryColor: suggested.primary,
      secondaryColor: suggested.secondary,
      accentColor: suggested.accent,
      backgroundColor: suggested.background,
      textColor: suggested.text,
      fontFamily: suggested.fontFamily,
    });
  };

  const approve = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const response = await api.post<{ warning?: string; contrast: number }>(`/brands/${clientId}/palette`, {
        primaryColor: draft.primaryColor,
        secondaryColor: draft.secondaryColor,
        accentColor: draft.accentColor,
        backgroundColor: draft.backgroundColor,
        textColor: draft.textColor,
        fontFamily: draft.fontFamily,
      });
      push({
        tone: response.warning ? 'info' : 'success',
        title: 'Identity approved',
        body: response.warning ?? `Text contrast ${response.contrast}:1.`,
      });
      refetch();
    } catch (err) {
      push({ tone: 'error', title: 'Could not approve', body: err instanceof Error ? err.message : undefined });
    } finally {
      setSaving(false);
    }
  };

  if (!portal && clients.data && clients.data.items.length === 0) {
    return (
      <>
        <PageHeader title={t('brand.dna')} />
        <Card><EmptyState icon={Palette} title={t('empty.clients.title')} body={t('empty.clients.body')} /></Card>
      </>
    );
  }

  if (loading || !draft) {
    return (
      <>
        <PageHeader title={t('brand.dna')} />
        {error ? <Card><ErrorState message={error} onRetry={refetch} /></Card> : <CardSkeleton rows={6} />}
      </>
    );
  }

  const readOnly = !isAgency;

  return (
    <>
      <PageHeader
        title={t('brand.dna')}
        subtitle="What the AI reads before it writes a single word for this client."
        action={
          <>
            {!portal && clients.data ? (
              <Select
                value={clientId}
                onChange={(event) => setParams({ client: event.target.value })}
                className="w-52"
              >
                {clients.data.items.map((client) => (
                  <option key={client.id} value={client.id}>{client.name}</option>
                ))}
              </Select>
            ) : null}
            {!readOnly ? <Button onClick={save} loading={saving}>{t('common.save')}</Button> : null}
          </>
        }
      />

      <Tabs
        className="mb-4"
        value={tab}
        onChange={setTab}
        tabs={[{ value: 'dna', label: t('brand.dna') }, { value: 'identity', label: t('brand.identity') }]}
      />

      {tab === 'dna' ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="The business" icon={Sparkles} />
            <div className="grid gap-4 p-5">
              <Field label="Business name"><Input value={draft.businessName} disabled={readOnly} onChange={(e) => setDraft({ ...draft, businessName: e.target.value })} /></Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Business type"><Input value={draft.businessType ?? ''} disabled={readOnly} onChange={(e) => setDraft({ ...draft, businessType: e.target.value })} /></Field>
                <Field label="Industry"><Input value={draft.industry ?? ''} disabled={readOnly} onChange={(e) => setDraft({ ...draft, industry: e.target.value })} /></Field>
              </div>
              <Field label="Description" hint="What the business actually does, in one or two sentences.">
                <Textarea value={draft.description ?? ''} disabled={readOnly} rows={3} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
              </Field>
              <Field label="Target audience">
                <Textarea value={draft.targetAudience ?? ''} disabled={readOnly} rows={2} onChange={(e) => setDraft({ ...draft, targetAudience: e.target.value })} />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Location"><Input value={draft.location ?? ''} disabled={readOnly} onChange={(e) => setDraft({ ...draft, location: e.target.value })} /></Field>
                <Field label="Content language">
                  <Select value={draft.preferredLanguage} disabled={readOnly} onChange={(e) => setDraft({ ...draft, preferredLanguage: e.target.value as Language })}>
                    <option value="EN">English</option>
                    <option value="AR">العربية</option>
                  </Select>
                </Field>
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="Voice and substance" icon={Palette} />
            <div className="grid gap-4 p-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Tone of voice"><Input value={draft.toneOfVoice ?? ''} disabled={readOnly} onChange={(e) => setDraft({ ...draft, toneOfVoice: e.target.value })} /></Field>
                <Field label="CTA style" hint="The wording used on buttons."><Input value={draft.ctaStyle ?? ''} disabled={readOnly} onChange={(e) => setDraft({ ...draft, ctaStyle: e.target.value })} /></Field>
              </div>
              <ListField label="Personality" value={draft.personality} onChange={(value) => setDraft({ ...draft, personality: value })} />
              <ListField label="Values" value={draft.values} onChange={(value) => setDraft({ ...draft, values: value })} />
              <ListField label="Products" value={draft.products} onChange={(value) => setDraft({ ...draft, products: value })} />
              <ListField label="Services" value={draft.services} onChange={(value) => setDraft({ ...draft, services: value })} />
              <ListField label="Unique selling points" value={draft.usps} onChange={(value) => setDraft({ ...draft, usps: value })} />
              <ListField label="Current offers" value={draft.offers} onChange={(value) => setDraft({ ...draft, offers: value })} />
              <ListField label="Keywords" value={draft.keywords} onChange={(value) => setDraft({ ...draft, keywords: value })} />
              <ListField
                label="Forbidden words"
                hint="Stripped from anything the AI writes, before it reaches you."
                value={draft.forbiddenWords}
                onChange={(value) => setDraft({ ...draft, forbiddenWords: value })}
              />
            </div>
          </Card>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
          <div className="space-y-4">
            <Card>
              <CardHeader
                title={t('brand.logo')}
                subtitle="Upload a logo and we suggest a palette from its actual pixels."
                icon={Upload}
                action={draft.paletteApproved ? <Badge tone="ok" dot>Approved</Badge> : <Badge tone="warn" dot>Not approved</Badge>}
              />
              <div className="flex flex-wrap items-center gap-5 p-5">
                <div className="grid h-24 w-24 shrink-0 place-items-center overflow-hidden rounded-2xl border border-line bg-elevated">
                  {draft.logoUrl ? (
                    <img src={draft.logoUrl} alt="Logo" className="h-full w-full object-contain p-2" />
                  ) : (
                    <Palette className="h-7 w-7 text-muted/50" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-muted">PNG, JPEG or WebP, up to 25 MB. SVG is not accepted — it can carry script.</p>
                  {!readOnly ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <input
                        ref={fileRef}
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/avif"
                        className="hidden"
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (file) void uploadLogo(file);
                        }}
                      />
                      <Button icon={Upload} loading={uploading} onClick={() => fileRef.current?.click()}>
                        {t('brand.uploadLogo')}
                      </Button>
                      {draft.logoUrl ? (
                        <Button
                          variant="secondary"
                          icon={Wand2}
                          onClick={async () => {
                            await api.post(`/brands/${clientId}/palette/suggest`);
                            refetch();
                            push({ tone: 'success', title: 'Palette re-extracted' });
                          }}
                        >
                          Re-analyse
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
            </Card>

            {draft.suggestedPalette ? (
              <Card>
                <CardHeader
                  title={t('brand.suggested')}
                  subtitle={`${draft.suggestedPalette.visualStyle} · suggested font ${draft.suggestedPalette.fontFamily}`}
                  icon={Sparkles}
                  action={!readOnly ? <Button size="sm" variant="secondary" onClick={applySuggestion}>Use these</Button> : null}
                />
                <div className="p-5">
                  <div className="mb-4 flex flex-wrap gap-2">
                    {draft.suggestedPalette.swatches.slice(0, 8).map((swatch) => (
                      <span key={swatch.hex} className="flex items-center gap-2 rounded-lg border border-line bg-elevated px-2 py-1.5">
                        <span className="h-5 w-5 rounded" style={{ background: swatch.hex }} />
                        <span className="tabular text-[12px] text-muted">{swatch.hex}</span>
                        <span className="tabular text-[11px] text-muted/70">{Math.round(swatch.weight * 100)}%</span>
                      </span>
                    ))}
                  </div>
                  {draft.suggestedPalette.notes.length > 0 ? (
                    <ul className="space-y-1 text-[13px] text-muted">
                      {draft.suggestedPalette.notes.map((note) => <li key={note}>• {note}</li>)}
                    </ul>
                  ) : null}
                </div>
              </Card>
            ) : null}

            <Card>
              <CardHeader
                title={t('brand.identity')}
                subtitle="These colours skin the client's portal."
                action={!readOnly ? <Button icon={Check} onClick={approve} loading={saving}>{t('brand.approve')}</Button> : null}
              />
              <div className="grid gap-3 p-5 sm:grid-cols-2">
                <Swatch label="Primary" color={draft.primaryColor} readOnly={readOnly} onChange={(value) => setDraft({ ...draft, primaryColor: value })} />
                <Swatch label="Secondary" color={draft.secondaryColor} readOnly={readOnly} onChange={(value) => setDraft({ ...draft, secondaryColor: value })} />
                <Swatch label="Accent" color={draft.accentColor} readOnly={readOnly} onChange={(value) => setDraft({ ...draft, accentColor: value })} />
                <Swatch label="Background" color={draft.backgroundColor} readOnly={readOnly} onChange={(value) => setDraft({ ...draft, backgroundColor: value })} />
                <Swatch label="Text" color={draft.textColor} readOnly={readOnly} onChange={(value) => setDraft({ ...draft, textColor: value })} />
                <Field label="Font family">
                  <Select value={draft.fontFamily} disabled={readOnly} onChange={(e) => setDraft({ ...draft, fontFamily: e.target.value })}>
                    {['Inter', 'Plus Jakarta Sans', 'Manrope', 'Poppins', 'DM Sans', 'Cairo', 'Tajawal'].map((font) => (
                      <option key={font} value={font}>{font}</option>
                    ))}
                  </Select>
                </Field>
              </div>
            </Card>
          </div>

          {/* Preview */}
          <div className="space-y-4 lg:sticky lg:top-20 lg:self-start">
            <Card>
              <CardHeader title={t('brand.preview')} />
              <div className="p-4">
                <div
                  className="rounded-xl border p-4"
                  style={{ background: draft.backgroundColor, borderColor: `${draft.primaryColor}33`, color: draft.textColor }}
                >
                  <div className="flex items-center gap-2.5">
                    {draft.logoUrl ? (
                      <img src={draft.logoUrl} alt="" className="h-9 w-9 rounded-lg object-contain" />
                    ) : (
                      <span className="h-9 w-9 rounded-lg" style={{ background: draft.primaryColor }} />
                    )}
                    <span className="font-semibold" style={{ fontFamily: draft.fontFamily }}>{draft.businessName}</span>
                  </div>
                  <p className="mt-3 text-[13px] opacity-80" style={{ fontFamily: draft.fontFamily }}>
                    {draft.description ?? 'Your brand description appears here.'}
                  </p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <span className="rounded-lg px-3 py-1.5 text-[13px] font-medium text-white" style={{ background: draft.primaryColor }}>
                      {draft.ctaStyle || 'Primary action'}
                    </span>
                    <span className="rounded-lg px-3 py-1.5 text-[13px] font-medium" style={{ background: `${draft.accentColor}22`, color: draft.accentColor }}>
                      Accent
                    </span>
                    <span className="rounded-lg px-3 py-1.5 text-[13px] font-medium" style={{ background: `${draft.secondaryColor}22`, color: draft.secondaryColor }}>
                      Secondary
                    </span>
                  </div>
                </div>
              </div>
            </Card>

            <Card>
              <CardHeader title="How a post would look" />
              <div className="p-4">
                <ContentPreview
                  platform="INSTAGRAM"
                  brandName={draft.businessName}
                  logoUrl={draft.logoUrl}
                  headline={draft.usps[0] ?? draft.businessName}
                  caption={draft.description ?? ''}
                  cta={draft.ctaStyle ?? 'Learn more'}
                  hashtags={draft.keywords.slice(0, 4).map((keyword) => `#${keyword.replace(/\s+/g, '')}`)}
                />
              </div>
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
