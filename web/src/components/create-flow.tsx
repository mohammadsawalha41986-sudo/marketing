/**
 * The global Create flow — one door into every kind of work.
 *
 * Two steps, in the order §12 and §13 set out: what, then where. The order
 * matters, because "an Instagram Story" and "a Story, on whichever platform has
 * one" are different starting thoughts, and only the second scales past two
 * platforms.
 *
 * Every offer here is checked against the capability matrix and the composer's
 * own surface registry before it is made. A type nothing can publish is not
 * listed; a platform that cannot run the chosen type is shown with the actual
 * reason — credentials missing, approval required, not implemented, not
 * supported — rather than greyed out. A disabled control with no explanation is
 * the failure mode this whole product is built against: the operator concludes
 * the product is broken, and they are not wrong to.
 *
 * Nothing is created here. The flow ends by navigating to the composer or the
 * advertising centre, which already own drafting, approval and publishing. A
 * second path into those would be a second thing to keep safe, and the paid one
 * spends money.
 */

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Clapperboard, Film, Image as ImageIcon, MapPin, Megaphone, PenLine, Plus, Wallet,
  type LucideIcon,
} from 'lucide-react';

import { useQuery } from '../lib/hooks';
import { useI18n, type TranslationKey } from '../lib/i18n';
import { cn } from '../lib/utils';
import type { Platform } from '../lib/api';
import type { PlatformCapability } from '../lib/workspace-content';
import { Badge, Button, Modal, Spinner } from './ui';
import { PlatformChip } from './domain';

type CapabilityState =
  | 'SUPPORTED' | 'NOT_CONFIGURED' | 'REQUIRES_APPROVAL' | 'NOT_SUPPORTED' | 'NOT_IMPLEMENTED';

interface Capability {
  surface: string;
  state: CapabilityState;
  detail: string;
  requiredEnv: string[];
  approval: string | null;
}

interface ChannelMatrix {
  channel: 'ORGANIC' | 'PAID';
  available: boolean;
  capabilities: Capability[];
  state: CapabilityState;
}

interface PlatformMatrix {
  platform: Platform;
  label: string;
  organic: ChannelMatrix;
  paid: ChannelMatrix;
}

type CreateType =
  | 'ORGANIC_POST' | 'PAID_AD' | 'CAMPAIGN' | 'VIDEO' | 'REEL' | 'STORY' | 'GBP_POST';

interface TypeSpec {
  key: CreateType;
  icon: LucideIcon;
  /** Which channel's capability decides whether a platform can run it. */
  channel: 'ORGANIC' | 'PAID';
  /** The matrix surface that must be usable. */
  surface: string;
  /**
   * A composer surface the platform must declare, for the types that name a
   * format. `null` means the channel capability alone decides.
   */
  requiresSurface: string | null;
  /** Restrict the offer to specific platforms, where the type names one. */
  only: Platform[] | null;
  /** Where the operator lands once a platform is chosen. */
  destination: (platform: Platform) => string;
}

const TYPES: TypeSpec[] = [
  {
    key: 'ORGANIC_POST',
    icon: PenLine,
    channel: 'ORGANIC',
    surface: 'PUBLISHING',
    requiresSurface: null,
    only: null,
    destination: () => '/app/social',
  },
  {
    key: 'PAID_AD',
    icon: Wallet,
    channel: 'PAID',
    surface: 'ADS',
    requiresSurface: null,
    only: null,
    // The advertising centre, which owns drafting an advertisement against a
    // campaign and the approval gate in front of publishing it. §29.
    destination: (platform) => `/app/marketing/advertising?platform=${platform}`,
  },
  {
    key: 'CAMPAIGN',
    icon: Megaphone,
    channel: 'PAID',
    surface: 'CAMPAIGNS',
    requiresSurface: null,
    only: null,
    destination: () => '/app/campaigns',
  },
  {
    key: 'VIDEO',
    icon: Clapperboard,
    channel: 'ORGANIC',
    surface: 'PUBLISHING',
    requiresSurface: 'VIDEO',
    only: null,
    destination: () => '/app/social',
  },
  {
    key: 'REEL',
    icon: Film,
    channel: 'ORGANIC',
    surface: 'PUBLISHING',
    requiresSurface: 'REEL',
    only: null,
    destination: () => '/app/social',
  },
  {
    key: 'STORY',
    icon: ImageIcon,
    channel: 'ORGANIC',
    surface: 'STORY',
    requiresSurface: 'STORY',
    only: null,
    destination: () => '/app/social',
  },
  {
    key: 'GBP_POST',
    icon: MapPin,
    channel: 'ORGANIC',
    surface: 'PUBLISHING',
    requiresSurface: null,
    only: ['GOOGLE_BUSINESS'],
    destination: () => '/app/google/locations',
  },
];

const USABLE: CapabilityState[] = ['SUPPORTED'];

/** What a platform can do about this type, and why when the answer is nothing. */
interface Offer {
  platform: Platform;
  state: CapabilityState;
  detail: string;
  usable: boolean;
}

function offersFor(
  spec: TypeSpec,
  matrices: PlatformMatrix[],
  capabilities: PlatformCapability[],
): Offer[] {
  return matrices
    .filter((matrix) => (spec.only ? spec.only.includes(matrix.platform) : true))
    .map((matrix) => {
      const channel = spec.channel === 'ORGANIC' ? matrix.organic : matrix.paid;

      /*
       * A channel the platform does not have at all answers with its own
       * sentence — "Snap publishes no API for posting organic content" — rather
       * than the generic per-surface one.
       */
      if (!channel.available) {
        return {
          platform: matrix.platform,
          state: channel.state,
          detail: channel.capabilities[0]?.detail ?? '',
          usable: false,
        };
      }

      const capability = channel.capabilities.find((entry) => entry.surface === spec.surface)
        ?? channel.capabilities[0];
      if (!capability) {
        return { platform: matrix.platform, state: 'NOT_IMPLEMENTED', detail: '', usable: false };
      }

      /*
       * A format check on top of the channel check. Meta organic publishing
       * being supported does not mean Facebook has Reels here — the composer's
       * own surface registry is what knows that, and offering a Reel the
       * composer has no surface for would end in a form with no fields.
       */
      if (spec.requiresSurface) {
        const declared = capabilities.find((entry) => entry.platform === matrix.platform);
        const has = declared?.surfaces.some(
          (surface) => surface.surface.toUpperCase() === spec.requiresSurface,
        ) ?? false;
        if (!has) {
          return {
            platform: matrix.platform,
            state: 'NOT_SUPPORTED',
            detail: capability.detail,
            usable: false,
          };
        }
      }

      return {
        platform: matrix.platform,
        state: capability.state,
        detail: capability.detail,
        usable: USABLE.includes(capability.state),
      };
    });
}

const STATE_TONES: Record<CapabilityState, 'ok' | 'warn' | 'neutral'> = {
  SUPPORTED: 'ok',
  REQUIRES_APPROVAL: 'warn',
  NOT_CONFIGURED: 'warn',
  NOT_IMPLEMENTED: 'neutral',
  NOT_SUPPORTED: 'neutral',
};

export function CreateFlow({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [chosen, setChosen] = useState<CreateType | null>(null);

  // Both are already fetched elsewhere in the app and are small, cacheable
  // reads; the modal asks only while it is open.
  const matrix = useQuery<{ platforms: PlatformMatrix[] }>(
    open ? '/marketing/capabilities' : null,
    [open],
  );
  const social = useQuery<{ platforms: PlatformCapability[] }>(
    open ? '/social/capabilities' : null,
    [open],
  );

  // Memoised so the derivation below does not recompute on every render just
  // because `?? []` produced a fresh array.
  const matrices = useMemo(() => matrix.data?.platforms ?? [], [matrix.data]);
  const capabilities = useMemo(() => social.data?.platforms ?? [], [social.data]);

  /** Only types at least one platform can actually run. §12. */
  const available = useMemo(
    () => TYPES.filter((spec) => {
      if (matrices.length === 0) return false;
      return offersFor(spec, matrices, capabilities).some((offer) => offer.usable);
    }),
    [matrices, capabilities],
  );

  const spec = chosen ? TYPES.find((entry) => entry.key === chosen) ?? null : null;
  const offers = spec ? offersFor(spec, matrices, capabilities) : [];

  const close = () => {
    setChosen(null);
    onClose();
  };

  const loading = matrix.loading || social.loading;

  return (
    <Modal
      open={open}
      onClose={close}
      title={spec ? t('create.platformTitle') : t('create.title')}
      subtitle={spec ? t('create.platformSubtitle') : t('create.subtitle')}
    >
      {loading ? (
        <div className="grid place-items-center py-12"><Spinner className="h-6 w-6" /></div>
      ) : !spec ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {available.length === 0 ? (
            /*
              * The type step needs its own sentence. It was borrowing the
              * platform step's — "No platform in this deployment can publish
              * this yet" — under a heading asking what you want to create,
              * where "this" refers to nothing the reader has chosen.
              */
            <p className="col-span-full py-8 text-center text-sm leading-relaxed text-muted">
              {t('create.noTypes')}
            </p>
          ) : available.map((entry) => (
            <button
              key={entry.key}
              onClick={() => setChosen(entry.key)}
              className="flex items-start gap-3 rounded-xl border border-line bg-surface p-3 text-start transition-colors hover:border-brand/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
            >
              <entry.icon className="mt-0.5 h-4 w-4 shrink-0 text-brand" aria-hidden />
              <div className="min-w-0">
                <p className="text-sm font-medium text-fg">
                  {t(`create.type.${entry.key}` as TranslationKey)}
                </p>
                <p className="mt-0.5 text-[12px] leading-snug text-muted">
                  {t(`create.body.${entry.key}` as TranslationKey)}
                </p>
              </div>
            </button>
          ))}
        </div>
      ) : (
        <>
          <div className="grid gap-2 sm:grid-cols-2">
            {offers.map((offer) => (
              <button
                key={offer.platform}
                disabled={!offer.usable}
                onClick={() => {
                  if (!offer.usable) return;
                  close();
                  navigate(spec.destination(offer.platform));
                }}
                className={cn(
                  'rounded-xl border p-3 text-start transition-colors',
                  offer.usable
                    ? 'border-line bg-surface hover:border-brand/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand'
                    : 'cursor-not-allowed border-line bg-elevated/40',
                )}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <PlatformChip platform={offer.platform} size="sm" />
                  {/* The reason, not a grey button. Wraps rather than
                      overflowing: these are clauses, not status words. */}
                  <Badge
                    tone={STATE_TONES[offer.state]}
                    className="whitespace-normal text-start leading-snug"
                  >
                    {t(`cap.${offer.state}` as TranslationKey)}
                  </Badge>
                </div>
                {!offer.usable && offer.detail ? (
                  <p className="mt-1.5 text-[12px] leading-snug text-muted" dir="auto">
                    {offer.detail}
                  </p>
                ) : null}
              </button>
            ))}
          </div>
          <div className="mt-4 flex justify-start">
            <Button variant="ghost" onClick={() => setChosen(null)}>{t('create.back')}</Button>
          </div>
        </>
      )}
    </Modal>
  );
}

/** The top bar's entry point. Owns the modal so every screen shares one. */
export function CreateButton() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button icon={Plus} onClick={() => setOpen(true)}>{t('create.button')}</Button>
      <CreateFlow open={open} onClose={() => setOpen(false)} />
    </>
  );
}
