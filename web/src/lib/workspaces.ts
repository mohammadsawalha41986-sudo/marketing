/**
 * Platform workspaces, client side.
 *
 * Membership — which platforms a workspace covers — is the server's answer and
 * is fetched from `/marketing/workspaces`; this module holds only what the
 * browser needs on its own: the route slug, the icon and the translation key
 * for the name. The one thing it deliberately does not hold is an opinion about
 * whether Instagram belongs to Meta, because two places holding that is how the
 * capability registries drifted apart before the matrix existed.
 *
 * The fallback below is used only until that fetch lands, so the sidebar can
 * render its labels on first paint rather than appearing a moment later and
 * moving everything under the cursor.
 */

import type { Platform } from './api';
import type { TranslationKey } from './i18n';

export type WorkspaceKey =
  | 'META' | 'TIKTOK' | 'GOOGLE' | 'YOUTUBE' | 'LINKEDIN' | 'SNAPCHAT';

export interface Workspace {
  key: WorkspaceKey;
  label: string;
  sublabel: string | null;
  platforms: Platform[];
}

export const WORKSPACE_ORDER: WorkspaceKey[] = [
  'META', 'TIKTOK', 'GOOGLE', 'YOUTUBE', 'LINKEDIN', 'SNAPCHAT',
];

export const WORKSPACE_LABEL_KEYS: Record<WorkspaceKey, TranslationKey> = {
  META: 'nav.meta',
  TIKTOK: 'nav.tiktok',
  GOOGLE: 'nav.google',
  YOUTUBE: 'nav.youtube',
  LINKEDIN: 'nav.linkedin',
  SNAPCHAT: 'nav.snapchat',
};

/** Route slug for a workspace. Lower case, matching the routes already shipped. */
export const workspaceSlug = (key: WorkspaceKey): string => key.toLowerCase();

export const workspacePath = (key: WorkspaceKey): string =>
  `/app/marketing/${workspaceSlug(key)}`;

/**
 * First-paint membership. Superseded by the server's answer as soon as it
 * arrives; nothing decides anything from this beyond which chips to draw.
 */
export const FALLBACK_WORKSPACES: Record<WorkspaceKey, Workspace> = {
  META: { key: 'META', label: 'Meta', sublabel: 'Facebook + Instagram', platforms: ['FACEBOOK', 'INSTAGRAM'] },
  TIKTOK: { key: 'TIKTOK', label: 'TikTok', sublabel: null, platforms: ['TIKTOK'] },
  GOOGLE: { key: 'GOOGLE', label: 'Google', sublabel: 'Business Profile + Google Ads', platforms: ['GOOGLE_BUSINESS', 'GOOGLE_ADS'] },
  YOUTUBE: { key: 'YOUTUBE', label: 'YouTube', sublabel: null, platforms: ['YOUTUBE'] },
  LINKEDIN: { key: 'LINKEDIN', label: 'LinkedIn', sublabel: null, platforms: ['LINKEDIN'] },
  SNAPCHAT: { key: 'SNAPCHAT', label: 'Snapchat', sublabel: null, platforms: ['SNAPCHAT'] },
};
