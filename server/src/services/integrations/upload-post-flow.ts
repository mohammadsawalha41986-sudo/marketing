/**
 * Connecting a restaurant to Upload-Post: create the profile, link the
 * accounts, attach what the operator chose.
 *
 * The lifecycle mirrors `connect-flow.ts` deliberately — the same statuses, the
 * same "nothing is attached that was not chosen" invariant, the same
 * `IntegrationAccount` rows the selection drawer already renders — but it is a
 * separate file because the middle step is not OAuth and pretending otherwise
 * would mean an authorization URL, a code exchange and a token where the
 * provider has none of the three.
 *
 *   connect      ensure this client's own Upload-Post profile exists, and mint
 *                a link to the hosted page where its social accounts are linked
 *   refresh      read the profile back and record every linked account,
 *                unselected, exactly as provider discovery does
 *   select       the shared `selectAccounts` — unchanged, and deliberately so
 *   disconnect   forget the connection here, and optionally delete the profile
 *
 * The return leg is a plain redirect with no secret in it, so there is no code
 * to redeem and nothing to bind a signed state to. What makes the flow safe is
 * that the profile name is *derived from the client id* rather than supplied:
 * an operator returning from Upload-Post can only ever cause this server to
 * re-read the profile belonging to the client they already had open, whatever
 * the browser sends back. Every route below re-derives it and none accepts one.
 */

import { IntegrationStatus, Platform, Prisma, type PrismaClient } from '@prisma/client';

import { discoveryNote } from './connection-notes.js';
import {
  UploadPostError,
  connectionUrl,
  deleteProfile,
  discoverFromProfile,
  ensureProfile,
  findProfile,
  profileUsernameFor,
  routablePlatforms,
  uploadPostConfig,
  uploadPostPlatform,
  type UploadPostFetch,
} from './upload-post.js';
import { KIND_FOR_DISCOVERY } from './account-kinds.js';

export interface ConnectResult {
  integrationId: string;
  /** Where the operator links their social accounts. */
  redirectTo: string;
  profile: string;
}

/**
 * Start — or resume — a restaurant's Upload-Post connection.
 *
 * Idempotent from end to end: the profile is created only if absent, the
 * integration row is upserted, and the accounts already attached are left
 * attached. An operator who connects again to add TikTok must not lose the
 * Instagram they linked last week.
 */
export async function beginUploadPostConnection(input: {
  prisma: PrismaClient;
  organizationId: string;
  clientId: string;
  /** Where Upload-Post returns the operator once they are done linking. */
  returnUrl: string;
  fetchImpl: UploadPostFetch;
}): Promise<ConnectResult> {
  const config = uploadPostConfig();
  const username = profileUsernameFor(input.clientId);

  const integration = await input.prisma.integration.upsert({
    where: { clientId_platform: { clientId: input.clientId, platform: Platform.UPLOAD_POST } },
    create: {
      organizationId: input.organizationId,
      clientId: input.clientId,
      platform: Platform.UPLOAD_POST,
      status: IntegrationStatus.CONNECTING,
      accountId: username,
      accountName: username,
    },
    // A retry clears the previous failure rather than leaving a stale error
    // sitting under a flow that is now in progress.
    update: { status: IntegrationStatus.CONNECTING, accountId: username, lastError: null },
    select: { id: true },
  });

  try {
    await ensureProfile({ config, username, fetchImpl: input.fetchImpl });

    const link = await connectionUrl({
      config,
      username,
      redirectUrl: input.returnUrl,
      // Only the networks this application can actually route to. Offering a
      // button for one it would never publish to invites an operator to link
      // something and then wonder why nothing ever posts.
      platforms: routablePlatforms()
        .map((platform) => uploadPostPlatform(platform))
        .filter((slug): slug is string => Boolean(slug)),
      fetchImpl: input.fetchImpl,
    });

    return { integrationId: integration.id, redirectTo: link.url, profile: username };
  } catch (error) {
    await failConnection(input.prisma, integration.id, error);
    throw error;
  }
}

/**
 * Read the profile back and record what is linked to it.
 *
 * Called when the operator returns from Upload-Post, and again whenever they
 * ask to refresh. Every discovered account is written **unselected**, which is
 * the same rule every provider's discovery follows and matters more here than
 * anywhere: one Upload-Post profile can hold seven networks, and attaching them
 * all because a token could see them is how a restaurant starts posting to an
 * account nobody chose.
 */
export async function refreshUploadPostAccounts(input: {
  prisma: PrismaClient;
  organizationId: string;
  clientId: string;
  fetchImpl: UploadPostFetch;
}): Promise<{ integrationId: string; discovered: number; refusals: number }> {
  const config = uploadPostConfig();
  const username = profileUsernameFor(input.clientId);

  const integration = await input.prisma.integration.findFirst({
    where: {
      organizationId: input.organizationId,
      clientId: input.clientId,
      platform: Platform.UPLOAD_POST,
    },
    select: { id: true, status: true },
  });
  if (!integration) throw new UploadPostError(404, 'Upload-Post is not connected for this restaurant.');

  try {
    const profile = await findProfile({ config, username, fetchImpl: input.fetchImpl });
    if (!profile) {
      throw new UploadPostError(
        404,
        `Upload-Post profiles: no profile named ${username} exists.`,
        'PROFILE_NOT_FOUND',
      );
    }

    const { accounts, refusals = [] } = discoverFromProfile(profile);

    await input.prisma.$transaction(async (tx) => {
      for (const account of accounts) {
        /*
         * Upsert on (integration, kind, externalId), exactly as provider
         * discovery does: re-reading the profile after linking one more network
         * refreshes names and never duplicates a row.
         */
        await tx.integrationAccount.upsert({
          where: {
            integrationId_kind_externalId: {
              integrationId: integration.id,
              kind: KIND_FOR_DISCOVERY[account.kind],
              externalId: account.externalId,
            },
          },
          create: {
            integrationId: integration.id,
            clientId: input.clientId,
            kind: KIND_FOR_DISCOVERY[account.kind],
            externalId: account.externalId,
            name: account.name,
            username: account.username ?? null,
            metadata: (account.metadata ?? {}) as Prisma.InputJsonValue,
            /*
             * No credential, and none invented. Upload-Post authorises the
             * deployment, so there is nothing per-account to store — and
             * `tokenStatus` stays at its REAUTH_REQUIRED default, which the
             * routed publishing path deliberately does not consult. Writing
             * TOKEN_VALID here would be a claim about a token that does not
             * exist.
             */
          },
          // `selected` is deliberately not updated: a refresh must not
          // re-attach a network the operator previously removed.
          update: {
            name: account.name,
            username: account.username ?? null,
            metadata: (account.metadata ?? {}) as Prisma.InputJsonValue,
          },
        });
      }

      /*
       * Networks that were linked and are no longer. Detached rather than
       * deleted: the row carries the operator's selection and its publishing
       * history, and an account that disappears from the profile for an hour
       * should not lose both. Unselecting it stops it publishing, which is the
       * part that matters.
       */
      const live = accounts.map((account) => account.externalId);
      await tx.integrationAccount.updateMany({
        where: {
          integrationId: integration.id,
          selected: true,
          ...(live.length > 0 ? { externalId: { notIn: live } } : {}),
        },
        data: { selected: false },
      });

      await tx.integration.update({
        where: { id: integration.id },
        data: {
          accountId: username,
          accountName: username,
          lastError: discoveryNote({
            platform: Platform.UPLOAD_POST,
            discovered: accounts.length,
            refusals,
          }),
        },
      });
    });

    return { integrationId: integration.id, discovered: accounts.length, refusals: refusals.length };
  } catch (error) {
    await failConnection(input.prisma, integration.id, error);
    throw error;
  }
}

/**
 * Forget this restaurant's Upload-Post connection.
 *
 * `deleteRemoteProfile` is the operator's choice and defaults to false. Leaving
 * the profile in place means reconnecting re-finds the accounts already linked
 * — the usual reason for disconnecting is to stop publishing, not to make
 * someone re-authorise seven networks. Deleting it is the deliberate, complete
 * removal, and is what a departing client should get.
 */
export async function disconnectUploadPost(input: {
  prisma: PrismaClient;
  organizationId: string;
  clientId: string;
  deleteRemoteProfile?: boolean;
  fetchImpl: UploadPostFetch;
}): Promise<{ disconnected: boolean; profileDeleted: boolean }> {
  const integration = await input.prisma.integration.findFirst({
    where: {
      organizationId: input.organizationId,
      clientId: input.clientId,
      platform: Platform.UPLOAD_POST,
    },
    select: { id: true },
  });
  if (!integration) return { disconnected: false, profileDeleted: false };

  let profileDeleted = false;
  if (input.deleteRemoteProfile) {
    /*
     * Best effort, and deliberately not fatal. If Upload-Post refuses the
     * delete, the local connection must still be torn down — leaving a
     * restaurant connected because a remote cleanup failed would mean it keeps
     * publishing after an operator asked it to stop.
     */
    try {
      await deleteProfile({
        config: uploadPostConfig(),
        username: profileUsernameFor(input.clientId),
        fetchImpl: input.fetchImpl,
      });
      profileDeleted = true;
    } catch {
      profileDeleted = false;
    }
  }

  await input.prisma.$transaction([
    // Nothing may publish through a disconnected route, so every account is
    // detached rather than merely the integration being relabelled.
    input.prisma.integrationAccount.updateMany({
      where: { integrationId: integration.id },
      data: { selected: false },
    }),
    input.prisma.integration.update({
      where: { id: integration.id },
      data: {
        status: IntegrationStatus.DISCONNECTED,
        lastError: null,
        // There is no stored credential to clear — that is the point of this
        // provider — but the columns are normalised anyway so no later read can
        // mistake a stale value for a live connection.
        accessTokenEnc: null,
        refreshTokenEnc: null,
        tokenExpiresAt: null,
        tokenFingerprint: null,
      },
    }),
  ]);

  return { disconnected: true, profileDeleted };
}

/** Park the connection in ERROR with the provider's own, key-free explanation. */
async function failConnection(prisma: PrismaClient, integrationId: string, error: unknown): Promise<void> {
  const message = error instanceof UploadPostError
    ? error.explanation
    : (error as Error).message.slice(0, 500);

  await prisma.integration.update({
    where: { id: integrationId },
    data: { status: IntegrationStatus.ERROR, lastError: message },
  });
}
