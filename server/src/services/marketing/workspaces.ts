/**
 * Platform workspaces — the grouping the operator navigates by.
 *
 * A workspace is not a `Platform`. Meta is one login, one app review, one
 * business manager and one ads account structure covering Facebook *and*
 * Instagram; an operator who connects Meta connects both, and asking them to
 * visit two pages to see the consequence of one authorisation describes our
 * enum rather than their work. Google is the same shape for a different reason:
 * Business Profile and Google Ads are separate products under one OAuth client.
 *
 * So the route segment is the workspace key, and the platforms it covers are
 * named here once. Every surface that needs "which platforms is this page
 * about" reads this rather than deciding for itself — the same rule the
 * capability matrix established, for the same reason.
 *
 * Single-platform slugs (`/facebook`, `/google_business`) still resolve, to
 * their own workspace, so existing links and bookmarks keep working.
 */

import { Platform } from '@prisma/client';

export type WorkspaceKey =
  | 'META' | 'TIKTOK' | 'GOOGLE' | 'YOUTUBE' | 'LINKEDIN' | 'SNAPCHAT';

export interface Workspace {
  key: WorkspaceKey;
  label: string;
  /** What the header says under the name, when the workspace covers several. */
  sublabel: string | null;
  platforms: Platform[];
}

export const WORKSPACES: Record<WorkspaceKey, Workspace> = {
  META: {
    key: 'META',
    label: 'Meta',
    sublabel: 'Facebook + Instagram',
    platforms: [Platform.FACEBOOK, Platform.INSTAGRAM],
  },
  TIKTOK: {
    key: 'TIKTOK', label: 'TikTok', sublabel: null, platforms: [Platform.TIKTOK],
  },
  GOOGLE: {
    key: 'GOOGLE',
    label: 'Google',
    sublabel: 'Business Profile + Google Ads',
    platforms: [Platform.GOOGLE_BUSINESS, Platform.GOOGLE_ADS],
  },
  YOUTUBE: {
    key: 'YOUTUBE', label: 'YouTube', sublabel: null, platforms: [Platform.YOUTUBE],
  },
  LINKEDIN: {
    key: 'LINKEDIN', label: 'LinkedIn', sublabel: null, platforms: [Platform.LINKEDIN],
  },
  SNAPCHAT: {
    key: 'SNAPCHAT', label: 'Snapchat', sublabel: null, platforms: [Platform.SNAPCHAT],
  },
};

export const WORKSPACE_ORDER: WorkspaceKey[] = [
  'META', 'TIKTOK', 'GOOGLE', 'YOUTUBE', 'LINKEDIN', 'SNAPCHAT',
];

/** Which workspace a platform belongs to. Every platform belongs to exactly one. */
const OWNER: Partial<Record<Platform, WorkspaceKey>> = {
  [Platform.FACEBOOK]: 'META',
  [Platform.INSTAGRAM]: 'META',
  [Platform.TIKTOK]: 'TIKTOK',
  [Platform.GOOGLE_BUSINESS]: 'GOOGLE',
  [Platform.GOOGLE_ADS]: 'GOOGLE',
  [Platform.YOUTUBE]: 'YOUTUBE',
  [Platform.LINKEDIN]: 'LINKEDIN',
  [Platform.SNAPCHAT]: 'SNAPCHAT',
};

export function workspaceOf(platform: Platform): Workspace | null {
  const key = OWNER[platform];
  return key ? WORKSPACES[key] : null;
}

/**
 * Resolve a route segment to a workspace.
 *
 * Accepts a workspace key (`meta`) or any platform inside one (`instagram`), so
 * the links this product shipped before workspaces existed still land somewhere
 * correct rather than on an error page.
 */
export function resolveWorkspace(slug: string): Workspace | null {
  const upper = slug.trim().toUpperCase();
  if (upper in WORKSPACES) return WORKSPACES[upper as WorkspaceKey];
  if (upper in OWNER) return workspaceOf(upper as Platform);
  return null;
}
