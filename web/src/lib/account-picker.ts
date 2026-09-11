/**
 * The account picker's vocabulary, per provider.
 *
 * The "Choose the accounts" drawer was written when Meta was the only
 * connection that could reach it, and it said so in every line: it told the
 * operator that "Meta returned everything this login can see", that "publishing
 * needs one ad account and one Page", and — when nothing came back — to "check
 * that it administers a Page and an ad account". It also rendered every
 * `parentExternalId` as "via Page …", because on Meta a parent is always the
 * Facebook Page an Instagram account hangs off.
 *
 * None of that is true of Google Ads. The provider is Google, the assets are
 * customer accounts, publishing needs exactly one of them and no Page exists,
 * and a parent is the *manager account* a customer was reached through. An
 * operator connecting Google Ads was therefore reading four sentences about a
 * product they had not connected, in front of a list of nothing.
 *
 * So the vocabulary is a lookup keyed by platform, kept here rather than inline
 * in the drawer for two reasons: it is pure and therefore testable without a
 * browser, and a provider added next is one entry rather than a hunt through
 * JSX for the word "Meta".
 *
 * The fallback is deliberately provider-neutral. A platform with no entry
 * should read as unspecific — never as Facebook, which is exactly the failure
 * this module exists to remove.
 */

import type { Platform } from './api';

/** What each account kind is called on screen, per provider's own vocabulary. */
type KindLabels = Record<string, string>;

const SHARED_KIND_LABELS: KindLabels = {
  PAGE: 'Facebook Page',
  INSTAGRAM: 'Instagram Professional',
  AD_ACCOUNT: 'Ad account',
  BUSINESS: 'Business',
  CUSTOMER: 'Customer',
  LOCATION: 'Location',
  ORGANIZATION: 'Organization',
  PROFILE: 'Profile',
};

export interface AccountPickerCopy {
  /** The provider, as a person names it. Never "Meta" unless it is Meta. */
  provider: string;
  /** The sentence above the list. Takes whatever the connection authorised as. */
  intro: (accountName: string) => string;
  /** Shown in place of the list when discovery returned nothing. */
  empty: string;
  /** Overrides for kinds this provider calls something of its own. */
  kindLabels?: KindLabels;
  /** Kinds first, in the order this provider's operator thinks about them. */
  kindOrder: string[];
  /**
   * What a parent account *is* here, or null where the provider has no parent
   * relationship worth showing. Meta's parent is the Page an Instagram account
   * is reached through; Google Ads' is the manager account. Rendering one as
   * the other names an object the operator does not have.
   */
  parentNoun: string | null;
}

const GENERIC: AccountPickerCopy = {
  provider: 'This provider',
  intro: (accountName) =>
    `${accountName} returned everything it can see. Attach only what belongs to this restaurant.`,
  empty:
    'No accounts came back for this login. Reconnect with an account that has access to one.',
  kindOrder: ['PAGE', 'INSTAGRAM', 'AD_ACCOUNT', 'BUSINESS', 'CUSTOMER', 'LOCATION', 'ORGANIZATION', 'PROFILE'],
  parentNoun: null,
};

/**
 * Per provider, and only where it differs. An entry that merely repeats the
 * generic one is a line that will drift out of date without being wrong enough
 * for anyone to notice.
 */
const COPY: Partial<Record<Platform, Partial<AccountPickerCopy>>> = {
  FACEBOOK: {
    provider: 'Meta',
    intro: (accountName) =>
      `Meta returned everything ${accountName} can see. Attach only what belongs to this restaurant — `
      + 'publishing needs one ad account and one Page.',
    empty: 'Meta returned no accounts for this login. Check that it administers a Page and an ad account.',
    kindOrder: ['PAGE', 'INSTAGRAM', 'AD_ACCOUNT', 'BUSINESS'],
    parentNoun: 'Page',
  },
  INSTAGRAM: {
    provider: 'Instagram',
    intro: (accountName) =>
      `Instagram returned the account ${accountName} logged in as. Attach it to connect this restaurant.`,
    empty:
      'Instagram returned no account for this login. Check that it is an Instagram Professional account.',
    kindOrder: ['INSTAGRAM', 'PROFILE'],
  },
  GOOGLE_ADS: {
    provider: 'Google Ads',
    intro: (accountName) =>
      `Google Ads returned every account ${accountName} can reach. Attach the one that belongs to this `
      + 'restaurant — campaigns and spend are read from it, and one is enough.',
    empty:
      'This Google login does not administer any Google Ads account. Connect again with the login that '
      + 'has access to the ad account, or ask its owner to grant that login access in Google Ads.',
    // The only kind Google Ads discovers. Named for the product, not for Meta's
    // generic "Ad account", so the label matches what Google Ads itself shows.
    kindLabels: { AD_ACCOUNT: 'Google Ads account' },
    kindOrder: ['AD_ACCOUNT'],
    parentNoun: 'manager account',
  },
  GOOGLE_BUSINESS: {
    provider: 'Google Business Profile',
    intro: (accountName) =>
      `Google returned the Business Profile accounts ${accountName} manages. Attach the one that owns this `
      + "restaurant's locations.",
    empty: 'This Google login manages no Business Profile accounts.',
    kindOrder: ['BUSINESS', 'LOCATION'],
  },
  YOUTUBE: {
    provider: 'YouTube',
    intro: (accountName) => `YouTube returned the channels ${accountName} owns. Attach the one to publish to.`,
    empty: 'This Google login owns no YouTube channel.',
    kindOrder: ['PROFILE'],
  },
  TIKTOK: {
    provider: 'TikTok',
    intro: (accountName) => `TikTok returned the account ${accountName} logged in as. Attach it to publish.`,
    empty: 'TikTok returned no account for this login.',
    kindOrder: ['PROFILE'],
  },
  UPLOAD_POST: {
    provider: 'Upload-Post',
    intro: () =>
      'These are the social accounts linked to this restaurant\'s Upload-Post profile. Attach the ones it '
      + 'should publish to — a network you also connect directly is published to directly, never twice.',
    empty:
      'No social accounts are linked to this restaurant\'s Upload-Post profile yet. Press Connect to open '
      + 'Upload-Post and link them, then refresh.',
    /*
     * Every network at once, which is what makes this connection different from
     * every other: one profile holds Instagram, TikTok, Facebook and the rest
     * side by side, so the list is grouped by the kind each network maps onto
     * and ordered the way an operator thinks about them.
     */
    kindOrder: ['INSTAGRAM', 'PAGE', 'PROFILE', 'BUSINESS'],
  },
  LINKEDIN: {
    provider: 'LinkedIn',
    intro: (accountName) =>
      `LinkedIn returned the organizations ${accountName} administers. Attach the one to publish as.`,
    empty: 'This LinkedIn account administers no company page.',
    kindOrder: ['ORGANIZATION', 'PAGE', 'PROFILE'],
  },
};

/** The drawer's wording for one platform. Unknown platforms read neutrally. */
export function accountPickerCopy(platform: Platform | null | undefined): AccountPickerCopy {
  return { ...GENERIC, ...(platform ? COPY[platform] ?? {} : {}) };
}

/** What this provider calls an account of this kind. */
export function accountKindLabel(platform: Platform | null | undefined, kind: string): string {
  const copy = accountPickerCopy(platform);
  return (
    copy.kindLabels?.[kind]
    ?? SHARED_KIND_LABELS[kind]
    ?? kind.replace(/_/g, ' ').toLowerCase()
  );
}

/** Sorts the kind groups into the order this provider's operator expects. */
export function compareAccountKinds(
  platform: Platform | null | undefined,
  a: string,
  b: string,
): number {
  const { kindOrder } = accountPickerCopy(platform);
  const rank = (kind: string) => {
    const index = kindOrder.indexOf(kind);
    return index === -1 ? kindOrder.length : index;
  };
  return rank(a) - rank(b) || a.localeCompare(b);
}

/**
 * The account's identifier, as its own provider prints it.
 *
 * Google Ads stores customer ids as ten digits and shows them everywhere —
 * Ads Manager, invoices, support — as 123-456-7890. An operator matching the
 * drawer against the tab next to it is comparing strings by eye, and the raw
 * digits are the one form they will not see anywhere else.
 */
export function formatExternalId(platform: Platform | null | undefined, externalId: string): string {
  if (platform !== 'GOOGLE_ADS') return externalId;

  const digits = externalId.replace(/\D/g, '');
  return digits.length === 10
    ? `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`
    : externalId;
}

/**
 * The "reached through X" line under an account, or null when there is none.
 *
 * Returns null rather than a guess for a provider with no parent relationship:
 * the previous unconditional "via Page …" would have labelled a Google Ads
 * manager account as a Facebook Page.
 */
export function parentAccountLine(input: {
  platform: Platform | null | undefined;
  parentExternalId: string | null;
  /** The parent's own row, when discovery also returned it. */
  parentName: string | undefined;
}): string | null {
  if (!input.parentExternalId) return null;

  const { parentNoun } = accountPickerCopy(input.platform);
  if (!parentNoun) return null;

  const identity =
    input.parentName ?? `${parentNoun} ${formatExternalId(input.platform, input.parentExternalId)}`;
  return `via ${identity}`;
}
