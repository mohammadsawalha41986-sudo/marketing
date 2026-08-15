/**
 * AI Studio.
 *
 * Generation is scoped to exactly one restaurant. The brief below is the whole
 * of what crosses into the AI service — it has no database access and is handed
 * one restaurant's brand context, so a draft for one restaurant cannot pick up
 * another's tone, offers or forbidden words.
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Hash, PenLine, Save, Sparkles, Wand2 } from 'lucide-react';

import {
  api, qs, CONTENT_TYPES, PLATFORMS,
  type ContentType, type Language, type Paginated, type Platform,
} from '../lib/api';
import { useQuery } from '../lib/hooks';
import { useI18n } from '../lib/i18n';
import { humanize } from '../lib/format';
import {
  Button, Card, CardHeader, Field, Input, PageHeader, Select, Textarea, useToast,
} from '../components/ui';
import { AiBadge, AiNotice, PlatformPreview } from '../components/domain';

interface Generated {
  headline: string;
  caption: string;
  primaryText: string;
  shortText: string;
  longText: string;
  slogan: string;
  cta: string;
  hashtags: string[];
  keywords: string[];
}

interface GenerateMeta {
  provider: string;
  model: string;
  isFallback: boolean;
  notice?: string;
}

const EMPTY: Generated = {
  headline: '', caption: '', primaryText: '', shortText: '',
  longText: '', slogan: '', cta: '', hashtags: [], keywords: [],
};

interface RestaurantOption {
  id: string;
  name: string;
  businessName: string;
  logoUrl: string | null;
}

export function AiStudioPage() {
  const { t } = useI18n();
  const { push } = useToast();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const restaurants = useQuery<Paginated<RestaurantOption>>(`/restaurants${qs({ pageSize: 100 })}`);

  const [brief, setBrief] = useState({
    restaurantId: params.get('restaurant') ?? '',
    campaignId: '',
    name: '',
    platform: 'INSTAGRAM' as Platform,
    contentType: 'POST' as ContentType,
    language: 'EN' as Language,
    tone: '',
    productService: '',
    offer: '',
    audience: '',
  });

  const [copy, setCopy] = useState<Generated>(EMPTY);
  const [meta, setMeta] = useState<GenerateMeta | null>(null);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [previewPlatform, setPreviewPlatform] = useState<Platform>('INSTAGRAM');

  const campaigns = useQuery<Paginated<{ id: string; name: string }>>(
    brief.restaurantId ? `/campaigns${qs({ restaurantId: brief.restaurantId, pageSize: 100 })}` : null,
    [brief.restaurantId],
  );

  // Default the first restaurant so the studio is usable straight away.
  useEffect(() => {
    if (!brief.restaurantId && restaurants.data?.items[0]) {
      setBrief((current) => ({ ...current, restaurantId: restaurants.data!.items[0]!.id }));
    }
  }, [restaurants.data, brief.restaurantId]);

  useEffect(() => setPreviewPlatform(brief.platform), [brief.platform]);

  const restaurant = useMemo(
    () => restaurants.data?.items.find((row) => row.id === brief.restaurantId),
    [restaurants.data, brief.restaurantId],
  );

  const generate = async () => {
    if (!brief.restaurantId) {
      push({ tone: 'error', title: 'Choose a restaurant first' });
      return;
    }
    setGenerating(true);
    try {
      const response = await api.post<{ generated: Generated; meta: GenerateMeta }>('/content/generate', {
        restaurantId: brief.restaurantId,
        platform: brief.platform,
        contentType: brief.contentType,
        language: brief.language,
        tone: brief.tone || undefined,
        productService: brief.productService || undefined,
        offer: brief.offer || undefined,
        audience: brief.audience || undefined,
        adName: brief.name || undefined,
      });
      setCopy(response.generated);
      setMeta(response.meta);
      push({ tone: 'success', title: 'Draft ready', body: t('ai.editable') });
    } catch (err) {
      push({ tone: 'error', title: 'Generation failed', body: err instanceof Error ? err.message : undefined });
    } finally {
      setGenerating(false);
    }
  };

  const regenerateHashtags = async () => {
    if (!brief.restaurantId) return;
    try {
      const response = await api.post<{ hashtags: string[] }>('/content/hashtags', {
        restaurantId: brief.restaurantId,
        platform: brief.platform,
        contentType: brief.contentType,
        language: brief.language,
        productService: brief.productService || undefined,
        offer: brief.offer || undefined,
      });
      setCopy((current) => ({ ...current, hashtags: response.hashtags }));
    } catch (err) {
      push({ tone: 'error', title: 'Could not generate hashtags', body: err instanceof Error ? err.message : undefined });
    }
  };

  const save = async () => {
    if (!brief.restaurantId || !brief.name.trim()) {
      push({ tone: 'error', title: 'A restaurant and a name are required' });
      return;
    }
    setSaving(true);
    try {
      const response = await api.post<{ content: { id: string } }>('/content', {
        restaurantId: brief.restaurantId,
        campaignId: brief.campaignId || null,
        name: brief.name.trim(),
        type: brief.contentType,
        status: 'DRAFT',
        platform: brief.platform,
        language: brief.language,
        tone: brief.tone || null,
        productService: brief.productService || null,
        offer: brief.offer || null,
        audience: brief.audience || null,
        headline: copy.headline || null,
        caption: copy.caption || null,
        primaryText: copy.primaryText || null,
        shortText: copy.shortText || null,
        longText: copy.longText || null,
        slogan: copy.slogan || null,
        cta: copy.cta || null,
        hashtags: copy.hashtags,
      });
      push({ tone: 'success', title: 'Saved as a draft' });
      navigate(`/content/${response.content.id}`);
    } catch (err) {
      push({ tone: 'error', title: 'Could not save', body: err instanceof Error ? err.message : undefined });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader
        title={t('ai.studio')}
        subtitle={t('ai.studioSub')}
        action={
          <>
            <Button variant="secondary" onClick={generate} loading={generating} icon={Wand2}>
              {generating ? t('ai.generating') : t('ai.generate')}
            </Button>
            <Button onClick={save} loading={saving} icon={Save}>{t('common.save')}</Button>
          </>
        }
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-4">
          <Card>
            <CardHeader title="The brief" subtitle="What the AI is given. Nothing else leaves this page." icon={PenLine} />
            <div className="grid gap-4 p-5 sm:grid-cols-2">
              <Field label={t('common.restaurant')} required>
                <Select
                  value={brief.restaurantId}
                  onChange={(e) => setBrief({ ...brief, restaurantId: e.target.value, campaignId: '' })}
                  required
                >
                  <option value="">Select a restaurant</option>
                  {restaurants.data?.items.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
                </Select>
              </Field>
              <Field label={t('common.campaign')}>
                <Select value={brief.campaignId} onChange={(e) => setBrief({ ...brief, campaignId: e.target.value })}>
                  <option value="">{t('common.none')}</option>
                  {campaigns.data?.items.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
                </Select>
              </Field>
              <Field label="Content name" required>
                <Input value={brief.name} onChange={(e) => setBrief({ ...brief, name: e.target.value })} placeholder="Weekend brunch — August" required />
              </Field>
              <Field label={t('common.platform')}>
                <Select value={brief.platform} onChange={(e) => setBrief({ ...brief, platform: e.target.value as Platform })}>
                  {PLATFORMS.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}
                </Select>
              </Field>
              <Field label={t('common.type')}>
                <Select value={brief.contentType} onChange={(e) => setBrief({ ...brief, contentType: e.target.value as ContentType })}>
                  {CONTENT_TYPES.map((value) => <option key={value} value={value}>{humanize(value)}</option>)}
                </Select>
              </Field>
              <Field label={t('common.language')}>
                <Select value={brief.language} onChange={(e) => setBrief({ ...brief, language: e.target.value as Language })}>
                  <option value="EN">English</option>
                  <option value="AR">العربية</option>
                </Select>
              </Field>
              <Field label="Dish or service">
                <Input value={brief.productService} onChange={(e) => setBrief({ ...brief, productService: e.target.value })} placeholder="Mixed grill platter" />
              </Field>
              <Field label="Offer">
                <Input value={brief.offer} onChange={(e) => setBrief({ ...brief, offer: e.target.value })} placeholder="20% off this week" />
              </Field>
              <Field label="Audience">
                <Input value={brief.audience} onChange={(e) => setBrief({ ...brief, audience: e.target.value })} />
              </Field>
              <Field label="Tone" hint="Defaults to the restaurant's tone of voice.">
                <Input value={brief.tone} onChange={(e) => setBrief({ ...brief, tone: e.target.value })} />
              </Field>
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Copy"
              subtitle={t('ai.editable')}
              icon={Sparkles}
              action={meta ? <AiBadge isFallback={meta.isFallback} /> : null}
            />
            <div className="space-y-4 p-5">
              {meta?.notice ? <AiNotice notice={meta.notice} /> : null}

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Headline"><Input value={copy.headline} onChange={(e) => setCopy({ ...copy, headline: e.target.value })} /></Field>
                <Field label="Slogan"><Input value={copy.slogan} onChange={(e) => setCopy({ ...copy, slogan: e.target.value })} /></Field>
              </div>
              <Field label="Caption"><Textarea value={copy.caption} onChange={(e) => setCopy({ ...copy, caption: e.target.value })} rows={4} /></Field>
              <Field label="Primary text"><Textarea value={copy.primaryText} onChange={(e) => setCopy({ ...copy, primaryText: e.target.value })} rows={3} /></Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Short text"><Input value={copy.shortText} onChange={(e) => setCopy({ ...copy, shortText: e.target.value })} /></Field>
                <Field label="Call to action"><Input value={copy.cta} onChange={(e) => setCopy({ ...copy, cta: e.target.value })} /></Field>
              </div>
              <Field label="Long text"><Textarea value={copy.longText} onChange={(e) => setCopy({ ...copy, longText: e.target.value })} rows={6} /></Field>

              <Field label="Hashtags">
                <div className="rounded-xl border border-line bg-elevated p-3">
                  <div className="mb-2 flex flex-wrap gap-1.5">
                    {copy.hashtags.length === 0 ? (
                      <span className="text-[13px] text-muted">None yet.</span>
                    ) : (
                      copy.hashtags.map((tag) => (
                        <button
                          key={tag}
                          onClick={() => setCopy({ ...copy, hashtags: copy.hashtags.filter((value) => value !== tag) })}
                          className="rounded-full border border-brand/25 bg-brand/10 px-2.5 py-0.5 text-[12px] text-brand transition-colors hover:border-danger/40 hover:bg-danger/10 hover:text-danger"
                          title="Remove"
                        >
                          {tag}
                        </button>
                      ))
                    )}
                  </div>
                  <Button variant="secondary" size="sm" icon={Hash} onClick={regenerateHashtags}>{t('ai.hashtags')}</Button>
                </div>
              </Field>
            </div>
          </Card>
        </div>

        <div className="space-y-4 xl:sticky xl:top-20 xl:self-start">
          <Card>
            <CardHeader title={t('brand.preview')} />
            <div className="p-4">
              <div className="mb-3 flex flex-wrap gap-1.5">
                {(['INSTAGRAM', 'FACEBOOK', 'TIKTOK', 'SNAPCHAT', 'GOOGLE_ADS'] as Platform[]).map((value) => (
                  <button
                    key={value}
                    onClick={() => setPreviewPlatform(value)}
                    className={`rounded-full border px-2.5 py-1 text-[12px] transition-colors ${
                      previewPlatform === value ? 'border-brand bg-brand/12 text-brand' : 'border-line text-muted hover:text-fg'
                    }`}
                  >
                    {humanize(value)}
                  </button>
                ))}
              </div>
              <PlatformPreview
                platform={previewPlatform}
                brandName={restaurant?.businessName ?? 'Your restaurant'}
                logoUrl={restaurant?.logoUrl}
                headline={copy.headline}
                caption={copy.caption}
                cta={copy.cta}
                hashtags={copy.hashtags}
              />
            </div>
          </Card>

          <Card className="p-4">
            <p className="text-[13px] leading-relaxed text-muted">
              The AI receives only this restaurant's brand identity and the brief above. It has no database access and
              cannot read another restaurant's data.
            </p>
          </Card>
        </div>
      </div>
    </>
  );
}
