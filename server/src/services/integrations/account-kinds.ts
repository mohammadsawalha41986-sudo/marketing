/**
 * How a discovered asset's kind becomes the column's.
 *
 * Extracted from `connect-flow.ts` when a second flow — Upload-Post, which is
 * not OAuth and so cannot share that file's lifecycle — needed the same
 * mapping. Two copies of it would be two answers to "what kind of row is an
 * Instagram account", and the selection drawer groups and labels by exactly
 * that value.
 *
 * Its own module rather than an export from either flow, because both import
 * it and neither should import the other.
 */

import { ExternalAccountKind } from '@prisma/client';

import type { DiscoveredAccount } from './meta.js';

export const KIND_FOR_DISCOVERY: Record<DiscoveredAccount['kind'], ExternalAccountKind> = {
  BUSINESS: ExternalAccountKind.BUSINESS,
  PAGE: ExternalAccountKind.PAGE,
  INSTAGRAM: ExternalAccountKind.INSTAGRAM,
  AD_ACCOUNT: ExternalAccountKind.AD_ACCOUNT,
  PROFILE: ExternalAccountKind.PROFILE,
};
