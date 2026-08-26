/**
 * Local SEO, limited to what Google actually returns.
 *
 * This file exists as much for what it refuses to do as for what it does.
 *
 * Local rank tracking, competitor rank comparison and local keyword research
 * have no official Google API. There is no endpoint that answers "where does
 * this branch rank for pizza near me", none that ranks a competitor, and
 * keyword ideas come only from the Google Ads Keyword Planner, which needs an
 * approved non-test developer token this deployment does not have. Every
 * product that appears to offer those is either scraping search results or
 * buying a third-party dataset.
 *
 * So they are not implemented, and — this is the part that matters — they are
 * not quietly omitted either. `unsupported()` names each one and says why, so
 * the workspace can render "Not available through the connected API" against a
 * capability rather than leaving a blank panel an operator reads as "no data
 * yet". A blank looks like a temporary state; a stated limit does not.
 *
 * What *is* real: everything below is computed from the Business Profile fields
 * Google returned for the location. A profile-completeness score is a fact
 * about the profile, and NAP consistency is a comparison between two things we
 * actually hold. Neither is a ranking claim.
 */

import type { GoogleLocation } from '@prisma/client';

export type AuditSeverity = 'CRITICAL' | 'WARNING' | 'OK';

export interface AuditFinding {
  key: string;
  severity: AuditSeverity;
  /** What was checked, in the operator's terms. */
  title: string;
  /** What was actually found. Never a prediction. */
  detail: string;
  /** What to do about it, when there is something to do. */
  action: string | null;
}

export interface LocationAudit {
  locationId: string;
  title: string;
  /** 0–100, from fields present on the profile. Not a ranking estimate. */
  completeness: number;
  findings: AuditFinding[];
}

/**
 * The fields Google Business Profile surfaces to customers, and what each is
 * worth to a completeness score.
 *
 * Weights are editorial: an address and a phone number are what a customer
 * needs to visit or call, so they carry the most. This is a checklist score,
 * and is labelled as one everywhere it is shown — it says how filled-in the
 * profile is, not how well it will rank.
 */
const FIELDS: Array<{
  key: string;
  weight: number;
  title: string;
  present: (location: GoogleLocation) => boolean;
  detail: string;
  action: string;
}> = [
  {
    key: 'address',
    weight: 25,
    title: 'Street address',
    present: (location) => location.addressLines.length > 0 && Boolean(location.locality),
    detail: 'Customers cannot find the branch without a complete address.',
    action: 'Add the full street address in the Business Profile.',
  },
  {
    key: 'phone',
    weight: 20,
    title: 'Phone number',
    present: (location) => Boolean(location.phone?.trim()),
    detail: 'No phone number is published on this profile.',
    action: 'Add the branch phone number so customers can call from Maps and Search.',
  },
  {
    key: 'website',
    weight: 20,
    title: 'Website link',
    present: (location) => Boolean(location.websiteUri?.trim()),
    detail: 'No website is linked from this profile.',
    action: 'Link the branch or main site so profile visitors can reach it.',
  },
  {
    key: 'category',
    weight: 20,
    title: 'Primary category',
    present: (location) => Boolean(location.primaryCategory?.trim()),
    detail: 'No primary category is set. Google uses it to decide which searches the profile is eligible for.',
    action: 'Set the primary category that matches what the branch actually sells.',
  },
  {
    key: 'storeCode',
    weight: 15,
    title: 'Store code',
    present: (location) => Boolean(location.storeCode?.trim()),
    detail: 'No store code is set, which makes branches harder to tell apart across systems.',
    action: 'Set a store code per branch to keep multi-location reporting unambiguous.',
  },
];

export function auditLocation(location: GoogleLocation): LocationAudit {
  const findings: AuditFinding[] = [];
  let score = 0;

  for (const field of FIELDS) {
    if (field.present(location)) {
      score += field.weight;
      findings.push({
        key: field.key,
        severity: 'OK',
        title: field.title,
        detail: 'Present on the profile.',
        action: null,
      });
    } else {
      findings.push({
        key: field.key,
        // Address and phone are how a customer reaches the business at all;
        // the rest cost visibility rather than reachability.
        severity: field.key === 'address' || field.key === 'phone' ? 'CRITICAL' : 'WARNING',
        title: field.title,
        detail: field.detail,
        action: field.action,
      });
    }
  }

  return {
    locationId: location.id,
    title: location.title,
    completeness: score,
    findings,
  };
}

export interface NapFinding {
  field: 'name' | 'phone' | 'website';
  severity: AuditSeverity;
  detail: string;
  values: string[];
}

/**
 * NAP consistency across a client's branches.
 *
 * Compares the profiles against each other, which is the comparison this
 * product can actually make: it holds every branch Google returned. It does not
 * claim to check directories, citations or aggregators — nothing here has
 * visited those, and reporting them as consistent would be asserting something
 * unverified.
 *
 * Differing addresses are correct and expected across branches, so address is
 * not compared. A brand name or a website that varies between branches usually
 * is a mistake.
 */
export function auditNap(locations: GoogleLocation[]): NapFinding[] {
  if (locations.length < 2) return [];

  const findings: NapFinding[] = [];

  // Brand naming: "Test Kitchen" and "Test Kitchen - Riyadh" are the same brand
  // named two ways, which is exactly what a consistency check should surface.
  const brandOf = (title: string) => title.split(/[-–—|(]/)[0]!.trim().toLowerCase();
  const brands = [...new Set(locations.map((location) => brandOf(location.title)))];
  if (brands.length > 1) {
    findings.push({
      field: 'name',
      severity: 'WARNING',
      detail: 'Branches publish different business names. Customers and Google both treat these as separate brands.',
      values: [...new Set(locations.map((location) => location.title))],
    });
  }

  const websites = [...new Set(
    locations.map((location) => location.websiteUri?.trim().replace(/\/+$/, '')).filter(Boolean) as string[],
  )];
  if (websites.length > 1) {
    findings.push({
      field: 'website',
      severity: 'WARNING',
      detail: 'Branches link to different websites. This is correct only if each branch genuinely has its own page.',
      values: websites,
    });
  }

  const missingPhones = locations.filter((location) => !location.phone?.trim());
  if (missingPhones.length > 0) {
    findings.push({
      field: 'phone',
      severity: 'CRITICAL',
      detail: missingPhones.length === 1
        ? '1 branch publishes no phone number.'
        : `${missingPhones.length} branches publish no phone number.`,
      values: missingPhones.map((location) => location.title),
    });
  }

  return findings;
}

export interface UnsupportedCapability {
  key: string;
  title: string;
  /** Why it is not here. Shown to the operator verbatim. */
  reason: string;
}

/**
 * Capabilities the Local SEO workspace does not have, and why.
 *
 * Rendered as "Not available through the connected API" rather than omitted, so
 * an operator looking for rank tracking learns it does not exist here instead
 * of assuming the data has not loaded.
 */
export function unsupported(): UnsupportedCapability[] {
  return [
    {
      key: 'RANK_TRACKING',
      title: 'Local ranking positions',
      reason: 'Google publishes no API for local search rankings. Any product showing them is scraping results or buying third-party data.',
    },
    {
      key: 'COMPETITOR_RANKS',
      title: 'Competitor comparison',
      reason: 'For the same reason as ranking positions: there is no official source for a competitor\'s local rank.',
    },
    {
      key: 'KEYWORD_RESEARCH',
      title: 'Local keyword research',
      reason: 'Keyword ideas come from the Google Ads Keyword Planner API, which requires an approved non-test developer token. This deployment does not have one.',
    },
    {
      key: 'SEARCH_VISIBILITY',
      title: 'Search visibility and impressions',
      reason: 'Available through Search Console, which is not connected yet. It is a separate Google product with its own scope.',
    },
  ];
}
