/**
 * Everything that has to be true before an advertisement can spend money.
 *
 * The publish flow already refuses on the things it cannot proceed without —
 * no connection, no ad account, missing media — but it discovers them one at a
 * time, in the middle of a sequence that may already have created a campaign in
 * the operator's account. Preflight asks all the questions first, together,
 * while nothing has happened yet.
 *
 * Three outcomes, and the distinction is the point. BLOCK means publishing
 * cannot succeed. WARNING means it can, but something is worth knowing — an
 * unmeasured video, no conversion tracking, a budget that will exhaust in a
 * day. PASS means the check found nothing.
 *
 * What this is not: a prediction of Meta's policy review. Nothing here can know
 * whether their reviewer will approve the creative, and a "preflight passed"
 * that reads as "approved" would be a lie the first time an ad is rejected. The
 * language stays deliberately about *our* checks.
 */

import { IntegrationStatus, Platform, PublicationStatus, type PrismaClient } from '@prisma/client';

import { storage } from '../storage/index.js';
import { validateCreative, type CheckOutcome } from '../creative/specs.js';

export type PreflightOutcome = 'PASS' | 'WARNING' | 'BLOCK';

export interface PreflightCheck {
  key: string;
  label: string;
  outcome: PreflightOutcome;
  detail: string;
  /** What the operator should do about it, when there is something to do. */
  fix: string | null;
}

export interface PreflightReport {
  publicationId: string;
  outcome: PreflightOutcome;
  canPublish: boolean;
  checks: PreflightCheck[];
  /** Plain sentence, because this is what the confirm dialog shows. */
  summary: string;
}

const pass = (key: string, label: string, detail: string): PreflightCheck =>
  ({ key, label, outcome: 'PASS', detail, fix: null });
const warn = (key: string, label: string, detail: string, fix: string | null = null): PreflightCheck =>
  ({ key, label, outcome: 'WARNING', detail, fix });
const block = (key: string, label: string, detail: string, fix: string): PreflightCheck =>
  ({ key, label, outcome: 'BLOCK', detail, fix });

/**
 * Run every check against a draft advertisement.
 *
 * Reads only. Nothing here writes, so preflight can be run as often as the
 * operator likes — including on every keystroke of a review screen.
 */
export async function preflight(input: {
  prisma: PrismaClient;
  publicationId: string;
  organizationId: string;
}): Promise<PreflightReport | null> {
  const { prisma } = input;

  const publication = await prisma.adPublication.findFirst({
    where: { id: input.publicationId, organizationId: input.organizationId },
  });
  if (!publication) return null;

  const checks: PreflightCheck[] = [];

  // ------------------------------------------------------------- lifecycle
  if (publication.status === PublicationStatus.PUBLISHED) {
    checks.push(
      block(
        'status',
        'Already published',
        'This advertisement has already been published to Meta.',
        'Create a new advertisement rather than republishing this one.',
      ),
    );
  } else if (publication.status === PublicationStatus.PUBLISHING) {
    checks.push(block('status', 'Publish in progress', 'A publish is already running for this advertisement.', 'Wait for it to finish.'));
  } else if (publication.status === PublicationStatus.APPROVED) {
    checks.push(pass('status', 'Approved', 'A human has approved this advertisement.'));
  } else {
    checks.push(
      block(
        'status',
        'Not approved',
        `This advertisement is ${publication.status.toLowerCase()}. Publishing spends the budget below.`,
        'Approve it first.',
      ),
    );
  }

  // ------------------------------------------------------------ connection
  const integration = await prisma.integration.findFirst({
    where: { clientId: publication.clientId, platform: { in: [Platform.FACEBOOK, Platform.INSTAGRAM] } },
    include: { accounts: { where: { selected: true } } },
  });

  if (!integration) {
    checks.push(block('connection', 'Meta connection', 'This restaurant is not connected to Meta.', 'Connect Meta on the Integrations page.'));
  } else if (integration.status !== IntegrationStatus.CONNECTED) {
    checks.push(
      block(
        'connection',
        'Meta connection',
        `The Meta connection is ${integration.status.toLowerCase()}.`,
        integration.status === IntegrationStatus.CONNECTING
          ? 'Finish the connection by choosing which accounts belong to this restaurant.'
          : 'Reconnect Meta on the Integrations page.',
      ),
    );
  } else if (!integration.accessTokenEnc) {
    checks.push(block('connection', 'Meta credential', 'The connection holds no usable credential.', 'Reconnect Meta.'));
  } else {
    checks.push(pass('connection', 'Meta connection', `Connected as ${integration.accountName ?? 'a Meta user'}.`));

    // A token with a known expiry that has passed cannot publish, and one that
    // expires within the flight is worth saying out loud.
    if (integration.tokenExpiresAt) {
      if (integration.tokenExpiresAt < new Date()) {
        checks.push(block('token', 'Credential expiry', 'The stored Meta token has expired.', 'Reconnect Meta.'));
      } else if (integration.tokenExpiresAt < publication.endDate) {
        checks.push(
          warn(
            'token',
            'Credential expiry',
            `The Meta token expires on ${integration.tokenExpiresAt.toISOString().slice(0, 10)}, before this campaign ends.`,
            'Reconnect Meta before then so metric syncs keep working.',
          ),
        );
      }
    }
  }

  const adAccount = integration?.accounts.find((account) => account.kind === 'AD_ACCOUNT');
  const page = integration?.accounts.find((account) => account.kind === 'PAGE');

  checks.push(
    adAccount
      ? pass('adAccount', 'Ad account', `${adAccount.name}${adAccount.currency ? ` · ${adAccount.currency}` : ''}`)
      : block('adAccount', 'Ad account', 'No Meta ad account is attached to this restaurant.', 'Choose one on the Integrations page.'),
  );
  checks.push(
    page
      ? pass('page', 'Facebook Page', page.name)
      : block('page', 'Facebook Page', 'No Facebook Page is attached to this restaurant.', 'Choose one on the Integrations page.'),
  );

  // ----------------------------------------------------------------- money
  /*
   * The currency check exists because getting it wrong is expensive and
   * invisible. Meta charges in the ad account's currency; if the draft says USD
   * and the account is SAR, the number the operator typed is not the number
   * that gets spent.
   */
  if (adAccount?.currency && adAccount.currency !== publication.currency) {
    checks.push(
      block(
        'currency',
        'Currency',
        `This advertisement is set to ${publication.currency}, but the ad account bills in ${adAccount.currency}.`,
        `Set the budget in ${adAccount.currency}.`,
      ),
    );
  } else if (adAccount?.currency) {
    checks.push(pass('currency', 'Currency', `${publication.currency}, matching the ad account.`));
  }

  const days = Math.max(
    1,
    Math.ceil((publication.endDate.getTime() - publication.startDate.getTime()) / 86_400_000),
  );
  const daily = Number(publication.dailyBudget);
  checks.push(
    pass(
      'budget',
      'Budget',
      `${daily} ${publication.currency} per day over ${days} day(s) — up to ${(daily * days).toFixed(2)} ${publication.currency}.`,
    ),
  );

  // ------------------------------------------------------------- schedule
  if (publication.endDate <= publication.startDate) {
    checks.push(block('schedule', 'Schedule', 'The end date is not after the start date.', 'Fix the flight dates.'));
  } else if (publication.endDate < new Date()) {
    checks.push(block('schedule', 'Schedule', 'This campaign has already ended.', 'Move the end date into the future.'));
  } else {
    checks.push(pass('schedule', 'Schedule', `${publication.startDate.toISOString().slice(0, 10)} → ${publication.endDate.toISOString().slice(0, 10)}`));
  }

  // ------------------------------------------------------------ the media
  const creative = publication.creativeId
    ? await prisma.creative.findFirst({
        where: { id: publication.creativeId },
        include: { media: true },
      })
    : null;
  const video = publication.videoCreativeId
    ? await prisma.videoCreative.findFirst({ where: { id: publication.videoCreativeId } })
    : null;

  if (!creative && !video) {
    checks.push(block('creative', 'Creative', 'Nothing is attached to this advertisement.', 'Attach a creative.'));
  } else {
    const storageKey = video?.storageKey ?? creative!.storageKey;
    const present = storage.exists ? await storage.exists(storageKey) : null;

    if (present === false) {
      checks.push(
        block(
          'media',
          'Creative file',
          'The file for this advertisement is no longer in storage.',
          'Re-upload the advertisement.',
        ),
      );
    } else if (present === null) {
      checks.push(warn('media', 'Creative file', 'This storage driver cannot confirm the file is present.'));
    } else {
      checks.push(pass('media', 'Creative file', 'The file is present in storage.'));
    }

    // Placement compatibility, from the same engine the upload screen used.
    const asset = creative?.media;
    if (asset && creative) {
      const summary = validateCreative(
        {
          kind: asset.type === 'VIDEO' ? 'VIDEO' : 'IMAGE',
          mimeType: asset.mimeType,
          sizeBytes: asset.sizeBytes,
          width: asset.width,
          height: asset.height,
          aspectRatio: asset.width && asset.height ? Number((asset.width / asset.height).toFixed(3)) : null,
          durationSeconds: asset.durationSeconds,
          measured: asset.width !== null,
        },
        publication.platform,
      );

      const usable = summary.placements.filter((row) => row.outcome !== 'INVALID');
      if (usable.length === 0) {
        checks.push(
          block(
            'placements',
            'Placements',
            `This creative does not fit any ${publication.platform.toLowerCase()} placement. ` +
              (summary.placements[0]?.blockingReason ?? ''),
            'Upload a version at the required shape.',
          ),
        );
      } else {
        const unknown = usable.filter((row: { outcome: CheckOutcome }) => row.outcome === 'UNKNOWN');
        checks.push(
          unknown.length > 0
            ? warn(
                'placements',
                'Placements',
                `${usable.length} placement(s) available, ${unknown.length} of which could not be fully measured.`,
              )
            : pass('placements', 'Placements', `Valid for ${usable.length} placement(s).`),
        );
      }
    }
  }

  // ------------------------------------------------------------ where it goes
  try {
    const url = new URL(publication.linkUrl);
    if (url.protocol !== 'https:') {
      checks.push(warn('destination', 'Destination', `The landing page is ${url.protocol}//, not https.`, 'Use an https link.'));
    } else {
      checks.push(pass('destination', 'Destination', url.host));
    }
  } catch {
    checks.push(block('destination', 'Destination', 'The landing page is not a valid URL.', 'Fix the destination link.'));
  }

  /*
   * Conversion tracking is a warning and never a block. Plenty of legitimate
   * campaigns are awareness or traffic, and refusing to publish those would be
   * wrong — but an operator who expects to see ROAS needs to know now that
   * revenue is not being measured, rather than in three weeks.
   */
  checks.push(
    warn(
      'conversions',
      'Conversion tracking',
      'No first-party conversion tracking is configured, so revenue and ROAS cannot be measured for this campaign.',
      'Spend and clicks will still be reported once metric ingestion is available.',
    ),
  );

  const blocking = checks.filter((check) => check.outcome === 'BLOCK');
  const warnings = checks.filter((check) => check.outcome === 'WARNING');

  return {
    publicationId: publication.id,
    outcome: blocking.length > 0 ? 'BLOCK' : warnings.length > 0 ? 'WARNING' : 'PASS',
    canPublish: blocking.length === 0,
    checks,
    summary:
      blocking.length > 0
        ? `${blocking.length} thing(s) must be fixed before this can be published.`
        : warnings.length > 0
          ? `Ready to publish, with ${warnings.length} thing(s) worth knowing first. These checks are ours — Meta reviews the ad separately.`
          : 'Every check passed. These checks are ours — Meta reviews the ad separately.',
  };
}
