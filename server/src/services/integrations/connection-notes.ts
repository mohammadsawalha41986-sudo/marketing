/**
 * What a connection tells its operator, in the provider's own vocabulary.
 *
 * Every sentence here used to be written once, in Meta's words, and reused for
 * every provider. That was invisible while Meta was the only connection that
 * worked and actively misleading the moment a second one did: an operator whose
 * Google Ads authorisation succeeded and discovered nothing was told to "check
 * that it administers a Page and an ad account", and one whose Google login
 * declined the `adwords` scope was told the *Meta app* had not been granted
 * `pages_manage_posts`. Both sentences name a product that has nothing to do
 * with the connection in front of them, and both send the operator to fix
 * something that is already correct.
 *
 * So the notes are per platform, and the fallback is deliberately generic
 * rather than Meta-shaped: a provider added tomorrow should read as unspecific,
 * never as Facebook.
 *
 * Nothing here interpolates a provider error verbatim except where the provider
 * is the only source of the fact (`refusals`), and those messages come from
 * `GoogleAdsError.explanation`, which is written for a UI and carries no token
 * material.
 */

import { Platform } from '@prisma/client';

import type { DiscoveryRefusal } from './meta.js';
import { targetNounFor } from '../publishing/target.js';

/** What discovery attaches on this platform, plural, as an operator says it. */
const DISCOVERED_NOUN: Record<Platform, string> = {
  [Platform.FACEBOOK]: 'Facebook Pages and ad accounts',
  [Platform.INSTAGRAM]: 'Instagram Professional accounts',
  [Platform.TIKTOK]: 'TikTok accounts',
  [Platform.YOUTUBE]: 'YouTube channels',
  [Platform.LINKEDIN]: 'LinkedIn organizations',
  [Platform.GOOGLE_BUSINESS]: 'Business Profile accounts',
  [Platform.GOOGLE_ADS]: 'Google Ads accounts',
  [Platform.SNAPCHAT]: 'Snapchat ad accounts',
  [Platform.X]: 'X accounts',
};

/**
 * Where the operator goes when the authorisation worked and found nothing.
 *
 * The right instruction differs per provider because the reason differs. A
 * Google login with no Ads account is a normal, common state and the remedy is
 * to authorise the Google account that actually holds the ad account — not to
 * reconnect the same one again, which is what a generic "try again" produces.
 */
const EMPTY_DISCOVERY_ADVICE: Partial<Record<Platform, string>> = {
  [Platform.FACEBOOK]:
    'Check that the Facebook account you authorised administers a Page, and that you granted access to it.',
  [Platform.INSTAGRAM]:
    'Check that the account you authorised is an Instagram Professional account.',
  [Platform.GOOGLE_ADS]:
    'The Google account you authorised does not administer any Google Ads account. '
    + 'Connect again with the Google login that has access to the ad account, or ask its owner to grant that login access in Google Ads.',
  [Platform.GOOGLE_BUSINESS]:
    'Check that the Google account you authorised manages a Business Profile.',
  [Platform.YOUTUBE]:
    'Check that the Google account you authorised owns a YouTube channel.',
  [Platform.LINKEDIN]:
    'Check that the LinkedIn account you authorised is an administrator of a company page.',
};

/**
 * What to tell the operator about what discovery found, or null when the list
 * speaks for itself.
 *
 * Written to `lastError` while the integration is still CONNECTING, which is
 * exactly what that column is for here: the authorisation is not in error, but
 * the operator is looking at a selection drawer that is empty or shorter than
 * they expected, and needs to be told why rather than left to guess. It is
 * cleared the moment something is attached.
 *
 * Two cases produce a note, and a full, unrefused list produces none:
 *
 *   nothing came back      provider-specific advice about which login to use.
 *                          A Google account with no Ads account is a normal
 *                          state with a specific remedy, not a failure to retry.
 *
 *   something was refused  the provider's own reason for the accounts missing
 *                          from an otherwise usable list. Silently dropping
 *                          them is how four of five ad accounts disappear with
 *                          nothing on screen to explain it.
 */
export function discoveryNote(input: {
  platform: Platform;
  discovered: number;
  refusals?: DiscoveryRefusal[];
}): string | null {
  const refusals = input.refusals ?? [];
  const noun = DISCOVERED_NOUN[input.platform];

  /*
   * The provider's own words come first where there are any: it is the only
   * party that knows why it refused. One message, not all of them — a login
   * refused for one reason is refused for that reason on every account, and a
   * wall of identical sentences buries the ids under it.
   */
  if (refusals.length > 0) {
    const ids = refusals.map((refusal) => refusal.externalId).join(', ');
    const opening = input.discovered === 0
      ? `The authorisation succeeded, but no ${noun} could be read.`
      : `${refusals.length} of the ${noun} this login can reach were not readable (${ids}).`;
    return `${opening} ${refusals[0]!.message}`;
  }

  if (input.discovered > 0) return null;

  const opening = `The authorisation succeeded, but no ${noun} came back.`;
  const advice = EMPTY_DISCOVERY_ADVICE[input.platform];
  return advice ? `${opening} ${advice}` : `${opening} Reconnect with an account that has access to one.`;
}

/**
 * Per-provider wording for an account attached with no usable credential.
 *
 * Facebook keeps the sentence it has always had, deliberately: a Page carries
 * its own publishing token, "no usable publishing token" is literally what went
 * wrong, and reconnecting Facebook with access to that Page is the fix. The
 * generic form below is for every provider where that sentence would describe
 * objects the flow does not have — Google Ads authorises the login, not the
 * customer, and has no Page to be granted access to.
 */
const NO_CREDENTIAL_NOTE: Partial<Record<Platform, string>> = {
  [Platform.FACEBOOK]:
    'The selected account has no usable publishing token. Reconnect Facebook and grant access to this Page.',
};

/** The note for a selection that attached something with no usable credential. */
export function noUsableCredentialNote(platform: Platform): string {
  return (
    NO_CREDENTIAL_NOTE[platform]
    ?? `The selected ${targetNounFor(platform)} has no usable credential for this connection. `
      + 'Reconnect this provider with an account that has access to it.'
  );
}

/**
 * What the grant this provider withheld actually stops, in that provider's terms.
 *
 * Facebook's entry preserves the sentence this note has always produced there.
 * Google Ads gets its own because "posts cannot be published" is not what an
 * absent `adwords` scope costs — an attached customer is an advertising target,
 * not a posting one.
 */
const WITHHELD_GRANT_CONSEQUENCE: Partial<Record<Platform, string>> = {
  [Platform.FACEBOOK]: 'so posts cannot be published to this Page yet',
  [Platform.GOOGLE_ADS]:
    'so campaigns cannot be created in it and its performance cannot be read',
};

/**
 * The note for an account attached while the grant it needs was withheld.
 *
 * `grant` is the scope `connect-flow` actually compared against when it marked
 * the account MISSING_PERMISSION, threaded in rather than looked up again, so
 * the permission named in the sentence is the one whose absence set the flag.
 * A provider with no such scope produces no note: there is nothing to warn
 * about, and inventing a warning is how `pages_manage_posts` ended up in a
 * Google Ads connection's error column.
 */
export function missingGrantNote(platform: Platform, grant: string | null): string | null {
  if (!grant) return null;

  const consequence =
    WITHHELD_GRANT_CONSEQUENCE[platform]
    ?? `so nothing can be published to the attached ${targetNounFor(platform)} yet`;

  return `Connected, but this authorisation does not include ${grant}, ${consequence}. Reconnect and grant it.`;
}
