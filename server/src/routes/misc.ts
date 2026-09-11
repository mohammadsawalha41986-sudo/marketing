/**
 * Smaller routers: notifications, integrations, subscriptions and users.
 * Grouped because each is a handful of endpoints over a single model.
 */

import { Router } from 'express';
import {
  IntegrationStatus, Language, Platform, Prisma, Role,
} from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../lib/prisma.js';
import { asyncHandler, badRequest, conflict, notFound } from '../lib/errors.js';
import { actorOf, requireAgency, requireAuth, requireManager } from '../middleware/auth.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import { idParam, pageResult, paginate, paginationQuery } from '../lib/http.js';
import { assertWritable, orgId, resolveClientId } from '../lib/scope.js';
import {
  adapterFor, connectable, providerReadiness, allAdapters, supportsOAuth,
  ProviderNotConfiguredError, ProviderNotImplementedError,
} from '../services/integrations/index.js';
import { beginAuthorization, bindProvider, selectAccounts } from '../services/integrations/connect-flow.js';
import { METRIC_SYNC_PLATFORMS, syncMetaMetrics } from '../services/integrations/metric-sync.js';
import {
  beginUploadPostConnection, disconnectUploadPost, refreshUploadPostAccounts,
} from '../services/integrations/upload-post-flow.js';
import {
  UploadPostError, profileUsernameFor, routablePlatforms, uploadPostConfigured,
  type UploadPostFetch,
} from '../services/integrations/upload-post.js';
import { routeCoverage } from '../services/publishing/route.js';
import { syncGoogleAdsMetrics, listGoogleAdsCampaigns } from '../services/integrations/google-ads-metrics.js';
import { GoogleAdsError } from '../services/integrations/google-ads.js';
import { decryptSecret } from '../lib/crypto.js';
import { env } from '../env.js';
import { hashPassword, passwordProblems } from '../lib/password.js';
import { recordAudit } from '../services/audit.js';
import { aiStatus } from '../services/ai/index.js';
import { testPublish } from '../services/publishing/service.js';
import {
  missingPublishGrant, noTargetMessage, resolveTargetForIntegration,
} from '../services/publishing/target.js';
import { publisherFor } from '../services/publishing/registry.js';

// ------------------------------------------------------------------ notifications

export const notificationsRouter: Router = Router();
notificationsRouter.use(requireAuth);

notificationsRouter.get(
  '/',
  validateQuery(paginationQuery.extend({ unreadOnly: z.coerce.boolean().default(false) })),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const query = req.query as unknown as z.infer<typeof paginationQuery> & { unreadOnly: boolean };

    const where: Prisma.NotificationWhereInput = {
      userId: actor.id,
      ...(query.unreadOnly ? { readAt: null } : {}),
    };

    const [items, total, unread] = await Promise.all([
      prisma.notification.findMany({ where, ...paginate(query), orderBy: { createdAt: 'desc' } }),
      prisma.notification.count({ where }),
      prisma.notification.count({ where: { userId: actor.id, readAt: null } }),
    ]);

    res.json({ ...pageResult(items, total, query), unread });
  }),
);

notificationsRouter.post(
  '/:id/read',
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    // Scoped by userId so one user cannot mark another's notification read.
    const { count } = await prisma.notification.updateMany({
      where: { id: req.params.id, userId: actor.id },
      data: { readAt: new Date() },
    });
    if (count === 0) throw notFound('Notification');
    res.json({ ok: true });
  }),
);

notificationsRouter.post(
  '/read-all',
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const { count } = await prisma.notification.updateMany({
      where: { userId: actor.id, readAt: null },
      data: { readAt: new Date() },
    });
    res.json({ ok: true, count });
  }),
);

// ------------------------------------------------------------------ integrations

/**
 * The unauthenticated OAuth callback router lives in `./oauth-callback.ts`.
 * It is mounted at the same base path, ahead of this router, so that the
 * provider's redirect resolves before `requireAuth` can challenge it.
 */

export const integrationsRouter: Router = Router();
integrationsRouter.use(requireAuth);

/** Catalogue of adapters and what each still needs before it can connect. */
integrationsRouter.get(
  '/catalog',
  asyncHandler(async (_req, res) => {
    res.json({
      ai: aiStatus(),
      adapters: allAdapters().map((adapter) => {
        const readiness = providerReadiness(adapter);
        const oauth = adapter.oauth();
        return {
          platform: adapter.platform,
          label: adapter.label,
          // `readiness` replaces the old boolean `implemented`: the UI needs to
          // distinguish "credentials missing" from "no encryption key" from
          // "ready", and each carries the text an operator can act on.
          readiness: readiness.state,
          readinessDetail: readiness.detail,
          ready: readiness.state === 'READY',
          missingEnv: readiness.missingEnv,
          capabilities: adapter.capabilities,
          /*
           * The second axis. Readiness says whether the deployment is
           * configured; this says whether the code exists. Six of these
           * adapters are ARCHITECTURE_ONLY and the UI must be able to say so
           * rather than showing a Connect button that returns 501.
           */
          implementation: adapter.implementation,
          /*
           * How this provider connects, and whether it can right now.
           *
           * `canConnect` asked `supportsOAuth` until Upload-Post — the first
           * provider that connects without OAuth — was reported as unbuildable
           * and had its Connect button disabled despite being implemented and
           * configured. The question meant here has always been "can this be
           * connected", not "is this OAuth", and now it asks that.
           */
          connectMethod: adapter.connectMethod,
          canConnect: connectable(adapter) && readiness.state === 'READY',
          /*
           * Whether a *post* can be sent, as distinct from `capabilities.publish`.
           * Google Ads publishes advertisements and has no organic publisher at
           * all, so a card reading `capabilities.publish` alone would offer a
           * Test publish button whose only possible outcome is a refusal.
           */
          organicPublish: Boolean(publisherFor(adapter.platform)?.canPublish),
          scopes: oauth.scopes,
          docsUrl: oauth.docsUrl,
        };
      }),
    });
  }),
);

integrationsRouter.get(
  '/',
  validateQuery(z.object({ clientId: z.string().max(40).optional() })),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const clientId = resolveClientId(actor, (req.query as { clientId?: string }).clientId);

    const items = await prisma.integration.findMany({
      where: { organizationId: orgId(actor), ...(clientId ? { clientId } : {}) },
      orderBy: { platform: 'asc' },
      // `credentials` is deliberately absent from this projection.
      select: {
        id: true, clientId: true, platform: true, status: true, accountName: true,
        accountId: true, scopes: true, lastSyncAt: true, lastError: true, updatedAt: true,
        client: { select: { id: true, name: true } },
      },
    });

    res.json({ items });
  }),
);

/*
 * Declared ABOVE the generic `/:clientId/:platform/connect` below, and it
 * has to be.
 *
 * Express matches in registration order, and `/:clientId/:platform/connect`
 * happily matches `/<client>/upload-post/connect` with `platform` bound to
 * the literal string "upload-post". Registered after it, these routes were
 * unreachable: pressing Connect answered 400 "Invalid path parameters,
 * expected FACEBOOK | INSTAGRAM | ..." — a validation error about an enum
 * the operator never chose, from a route they never meant to call.
 *
 * The same shadowing the social router already carries a note about, for the
 * same reason: a literal segment that could also bind a parameter must be
 * declared first or it is decoration.
 */
// ------------------------------------------------------ upload-post

/**
 * Upload-Post's own connect surface.
 *
 * Separate endpoints rather than the generic `/:clientId/:platform/connect`,
 * because Upload-Post is not an OAuth provider: there is no authorize URL to
 * redirect to, no code to exchange and no per-client token to store. The
 * generic route correctly refuses it (`supportsOAuth` is false for this
 * adapter) and these take over.
 *
 * Every one of them derives the profile name from the *path's* client id, which
 * is itself checked against the caller's organisation first. No route here
 * accepts a profile name, and that is the whole tenant boundary: an operator
 * cannot name another restaurant's profile, and a browser returning from
 * Upload-Post cannot cause this server to read one.
 *
 * The API key appears in no request and no response. What the browser receives
 * is a hosted linking URL Upload-Post minted for one profile.
 */
const uploadPostFetch = fetch as unknown as UploadPostFetch;

/** The client, if it belongs to this actor's organisation. 404 otherwise. */
async function ownedClient(actor: ReturnType<typeof actorOf>, clientId: string) {
  const client = await prisma.client.findFirst({
    where: { id: clientId, organizationId: orgId(actor) },
    select: { id: true },
  });
  if (!client) throw notFound('Client');
  return client;
}

/** Upload-Post failures are the operator's or the deployment's, never a 500. */
function rethrowUploadPost(error: unknown): never {
  if (error instanceof UploadPostError) {
    /*
     * The connect explanation, never the raw message: both are written for a
     * person and carry no key material, but only one of them is about the thing
     * the operator was actually doing. The publishing wording leaked here and
     * told someone pressing Connect that "the post will be retried".
     */
    throw badRequest(error.connectExplanation);
  }
  if (error instanceof ProviderNotConfiguredError) throw badRequest(error.message);
  throw error;
}

integrationsRouter.post(
  '/:clientId/upload-post/connect',
  requireAgency,
  validateParams(z.object({ clientId: z.string().min(1).max(40) })),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);
    const { clientId } = req.params as unknown as { clientId: string };
    await ownedClient(actor, clientId);

    try {
      const result = await beginUploadPostConnection({
        prisma,
        organizationId: orgId(actor),
        clientId,
        /*
         * Where Upload-Post sends the operator when they are done. It carries
         * the client so the page can finish the connection for the restaurant
         * that started it, and nothing else — no token, no profile name, and
         * nothing the server will trust without re-deriving it.
         */
        returnUrl: `${env.APP_URL}/app/integrations?uploadPost=linked&client=${encodeURIComponent(clientId)}`,
        fetchImpl: uploadPostFetch,
      });

      await recordAudit({
        actor, action: 'integration.connect', entity: 'Integration', entityId: result.integrationId,
        meta: { platform: Platform.UPLOAD_POST }, ip: req.ip,
      });

      res.json({ redirectTo: result.redirectTo, integrationId: result.integrationId, profile: result.profile });
    } catch (error) {
      rethrowUploadPost(error);
    }
  }),
);

/**
 * Re-read the profile and record what is linked to it.
 *
 * Called when the operator returns from the hosted page, and whenever they ask
 * to look again. Discovery only — nothing is attached here, because attaching
 * is the operator's choice and goes through the same `/:id/select` every
 * provider uses.
 */
integrationsRouter.post(
  '/:clientId/upload-post/refresh',
  requireAgency,
  validateParams(z.object({ clientId: z.string().min(1).max(40) })),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);
    const { clientId } = req.params as unknown as { clientId: string };
    await ownedClient(actor, clientId);

    try {
      const result = await refreshUploadPostAccounts({
        prisma,
        organizationId: orgId(actor),
        clientId,
        fetchImpl: uploadPostFetch,
      });
      res.json(result);
    } catch (error) {
      rethrowUploadPost(error);
    }
  }),
);

integrationsRouter.post(
  '/:clientId/upload-post/disconnect',
  requireAgency,
  validateParams(z.object({ clientId: z.string().min(1).max(40) })),
  validateBody(z.object({
    /*
     * Off by default. Disconnecting usually means "stop publishing", and
     * deleting the remote profile would make an operator re-link every network
     * to undo it. Deleting is the deliberate, complete removal.
     */
    deleteProfile: z.boolean().default(false),
  })),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);
    const { clientId } = req.params as unknown as { clientId: string };
    await ownedClient(actor, clientId);

    const result = await disconnectUploadPost({
      prisma,
      organizationId: orgId(actor),
      clientId,
      deleteRemoteProfile: (req.body as { deleteProfile: boolean }).deleteProfile,
      fetchImpl: uploadPostFetch,
    });

    await recordAudit({
      actor, action: 'integration.disconnect', entity: 'Client', entityId: clientId,
      meta: { platform: Platform.UPLOAD_POST, profileDeleted: result.profileDeleted }, ip: req.ip,
    });

    res.json(result);
  }),
);

/**
 * Which connection each network would publish through for this restaurant.
 *
 * The question an operator cannot otherwise answer without publishing: a
 * restaurant may hold a direct Instagram connection and an Upload-Post profile
 * carrying Instagram, and exactly one of them carries the post. This reports
 * the resolver's actual answer rather than a second opinion about it — so what
 * the screen shows and what publishes can never disagree.
 */
integrationsRouter.get(
  '/:clientId/publishing-routes',
  validateParams(z.object({ clientId: z.string().min(1).max(40) })),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const { clientId } = req.params as unknown as { clientId: string };
    await ownedClient(actor, clientId);

    const routes = await routeCoverage({
      prisma,
      organizationId: orgId(actor),
      clientId,
      platforms: routablePlatforms(),
    });

    res.json({
      configured: uploadPostConfigured(),
      // Derived, never stored as a secret: it is a name, and the operator needs
      // it to find the right profile in Upload-Post's own dashboard.
      profile: profileUsernameFor(clientId),
      routes,
    });
  }),
);

/**
 * Begin a connection. Every adapter currently refuses, and says exactly which
 * environment variables and adapter work are missing — no fake "connected".
 */
integrationsRouter.post(
  '/:clientId/:platform/connect',
  requireAgency,
  validateParams(z.object({ clientId: z.string().min(1).max(40), platform: z.nativeEnum(Platform) })),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);
    const { clientId, platform } = req.params as unknown as { clientId: string; platform: Platform };

    const client = await prisma.client.findFirst({
      where: { id: clientId, organizationId: orgId(actor) },
      select: { id: true },
    });
    if (!client) throw notFound('Client');

    const adapter = adapterFor(platform);
    const readiness = providerReadiness(adapter);

    /*
     * The row exists even when the connection cannot proceed, so the
     * integrations screen can list the provider as honestly disconnected rather
     * than omitting it. `beginAuthorization` upserts the same row and moves it
     * to CONNECTING, so this is not a competing write.
     */
    await prisma.integration.upsert({
      where: { clientId_platform: { clientId, platform } },
      create: { organizationId: orgId(actor), clientId, platform, status: IntegrationStatus.DISCONNECTED },
      update: {},
    });

    /*
     * Two different refusals, asked in this order.
     *
     * "Not built" comes first because it is not fixable by configuration: an
     * X adapter with all three variables set is configured and still cannot
     * start a flow. Reporting NOT_CONFIGURED there would send an operator to
     * add variables that are already present.
     */
    if (!supportsOAuth(adapter)) {
      res.status(501).json({
        error: {
          code: 'PROVIDER_NOT_IMPLEMENTED',
          message: new ProviderNotImplementedError(adapter, 'oauth').message,
          details: {
            platform,
            implementation: adapter.implementation,
            docsUrl: adapter.oauth().docsUrl,
          },
        },
      });
      return;
    }

    if (readiness.state !== 'READY') {
      res.status(503).json({
        error: {
          code: readiness.state === 'NO_ENCRYPTION' ? 'ENCRYPTION_NOT_CONFIGURED' : 'PROVIDER_NOT_CONFIGURED',
          message: readiness.detail,
          details: { platform, missingEnv: readiness.missingEnv, readiness: readiness.state, docsUrl: adapter.oauth().docsUrl },
        },
      });
      return;
    }

    try {
      /*
       * The real flow, at last. `beginAuthorization` mints a tenant-bound
       * single-use state, parks the integration in CONNECTING and returns
       * Meta's own authorization URL. Nothing is CONNECTED until the callback
       * validates a token and the operator picks the accounts.
       */
      const { redirectTo, integrationId } = await beginAuthorization({
        organizationId: orgId(actor),
        clientId,
        platform,
        baseUrl: env.APP_URL,
      });

      await recordAudit({
        actor, action: 'integration.connect', entity: 'Integration', entityId: integrationId,
        meta: { platform }, ip: req.ip,
      });

      res.json({ redirectTo, integrationId });
    } catch (error) {
      // A missing credential is a configuration problem with a known fix, not a
      // server fault — 503 with the exact variable names, so the response tells
      // the operator what to do rather than that something is unavailable.
      if (error instanceof ProviderNotConfiguredError) {
        res.status(503).json({
          error: {
            code: 'PROVIDER_NOT_CONFIGURED',
            message: error.message,
            details: {
              platform,
              missingEnv: error.missingEnv,
              readiness: readiness.state,
              docsUrl: adapter.oauth().docsUrl,
            },
          },
        });
        return;
      }
      throw error;
    }
  }),
);

/**
 * What the provider said this account can see, and what the operator has picked.
 *
 * Discovery writes every asset unselected, so this is the list the selection
 * screen renders. `selected` is the operator's answer, not Meta's.
 */
integrationsRouter.get(
  '/:id/accounts',
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);

    const integration = await prisma.integration.findFirst({
      where: { id: req.params.id, organizationId: orgId(actor) },
      select: {
        id: true, clientId: true, platform: true, status: true, accountName: true, lastError: true,
        accounts: {
          orderBy: [{ kind: 'asc' }, { name: 'asc' }],
          /*
           * An explicit allowlist, and it stays that way. `accessTokenEnc` lives
           * on this row; `tokenStatus` is the verdict about it and is the only
           * part a browser may see. Selecting the whole model here would put a
           * Page's publishing credential in an API response.
           */
          select: {
            id: true, kind: true, externalId: true, name: true, username: true,
            currency: true, timezone: true, parentExternalId: true, selected: true,
            tokenStatus: true, tokenExpiresAt: true, tokenCheckedAt: true,
          },
        },
      },
    });
    if (!integration) throw notFound('Integration');

    res.json({ integration });
  }),
);

/**
 * Attach the accounts the operator chose. This is what completes a connection.
 *
 * Ids that do not belong to this integration are dropped by `selectAccounts`
 * rather than trusted — a request body is not an authorisation to attach
 * somebody else's ad account.
 */
integrationsRouter.post(
  '/:id/select',
  requireAgency,
  validateParams(idParam),
  validateBody(z.object({ accountIds: z.array(z.string().max(40)).max(50) })),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);

    const existing = await prisma.integration.findFirst({
      where: { id: req.params.id, organizationId: orgId(actor) },
      select: { id: true, platform: true },
    });
    if (!existing) throw notFound('Integration');

    const result = await selectAccounts({
      integrationId: existing.id,
      organizationId: orgId(actor),
      accountIds: (req.body as { accountIds: string[] }).accountIds,
    });

    await recordAudit({
      actor, action: 'integration.select', entity: 'Integration', entityId: existing.id,
      meta: { platform: existing.platform, selected: result.selected, status: result.status }, ip: req.ip,
    });

    res.json(result);
  }),
);

/**
 * Publish a one-off message to a connected Page, against the real provider.
 *
 * This exists to answer one question that no test can: does this deployment,
 * with these credentials and this Page, actually publish? Every automated test
 * uses a fake `fetch` with a real response shape, which proves the workflow
 * handles each answer and proves nothing about whether Meta gives that answer.
 *
 * It is deliberately not a shortcut around the content workflow. It publishes
 * the caller's message and returns the provider's post id; it does not touch
 * Content, does not create a PublishingJob, and cannot mark anything PUBLISHED.
 * A real post does appear on the Page, so it is agency-only, writable-actor
 * only, and audited.
 *
 * The token appears nowhere: not in the request, not in the response, not in
 * the audit entry, and not in the error path.
 */
integrationsRouter.post(
  '/:id/test-publish',
  requireAgency,
  validateParams(idParam),
  validateBody(z.object({ message: z.string().trim().min(1).max(2000) })),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);

    const { message } = req.body as { message: string };

    const integration = await prisma.integration.findFirst({
      where: { id: req.params.id, organizationId: orgId(actor) },
      select: { id: true, platform: true },
    });
    if (!integration) throw notFound('Integration');

    /*
     * What this connection publishes to, asked of the one resolver that knows.
     *
     * This used to select accounts of kind PAGE and nothing else, which is
     * right for Facebook and wrong for every other platform — an Instagram
     * Login connection, whose target is the Instagram Professional account
     * itself, was told to choose a Page it can never have.
     */
    const account = await resolveTargetForIntegration({
      prisma,
      integrationId: integration.id,
      platform: integration.platform,
    });
    if (!account) throw badRequest(noTargetMessage(integration.platform));

    /*
     * The grant was recorded when the account was attached, so a connection
     * authorised without the publishing permission is knowable before a request
     * is sent — and worth naming exactly, rather than spending a call to have
     * the provider say it less clearly.
     */
    const missingGrant = missingPublishGrant(integration.platform, account);
    if (missingGrant) throw badRequest(missingGrant);

    const result = await testPublish({
      prisma,
      accountId: account.id,
      message,
      platform: integration.platform,
      fetchImpl: fetch as never,
    });

    await recordAudit({
      actor,
      action: 'integration.test-publish',
      entity: 'Integration',
      entityId: integration.id,
      // The target and the outcome, never the credential or the message body.
      meta: {
        platform: integration.platform,
        accountId: account.externalId,
        success: result.published,
        externalPostId: result.published ? result.externalPostId : null,
      },
      ip: req.ip,
    });

    if (!result.published) {
      /*
       * The provider's real reason, surfaced rather than flattened into a 500.
       * 502: the request was fine and the upstream refused it.
       */
      res.status(502).json({
        error: { code: result.code, message: result.message, providerCode: result.providerCode },
      });
      return;
    }

    // A real post now exists on the account. The id is the provider's.
    res.json({
      published: true,
      accountId: account.externalId,
      accountName: account.name,
      externalPostId: result.externalPostId,
      permalink: result.permalink,
      publishedAt: result.publishedAt,
    });
  }),
);

/**
 * Ask the provider whether this connection still works.
 *
 * A stored token is not a connection. This spends a real validation call so the
 * answer comes from the provider rather than from our own status column, and
 * parks the integration in ERROR when the credential is rejected — which is how
 * an expired token stops being a mystery.
 *
 * The call is the connection's own provider's, not Meta's. It used to be Meta's
 * for every platform, so checking the health of a working Google Ads connection
 * sent a Google token to Facebook's Graph `/me` — a guaranteed refusal — and
 * wrote ERROR over a connection that was fine.
 */
integrationsRouter.get(
  '/:id/health',
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);

    const integration = await prisma.integration.findFirst({
      where: { id: req.params.id, organizationId: orgId(actor) },
      select: {
        id: true, platform: true, status: true, accessTokenEnc: true, tokenExpiresAt: true,
        accounts: { where: { selected: true }, select: { kind: true } },
      },
    });
    if (!integration) throw notFound('Integration');

    const adapter = adapterFor(integration.platform);
    const readiness = providerReadiness(adapter);

    const base = {
      integrationId: integration.id,
      platform: integration.platform,
      status: integration.status,
      readiness: readiness.state,
      implementation: adapter.implementation,
      selectedKinds: integration.accounts.map((account) => account.kind),
      tokenExpiresAt: integration.tokenExpiresAt,
    };

    if (!integration.accessTokenEnc) {
      res.json({ ...base, live: false, detail: 'No credential is stored for this connection.' });
      return;
    }
    if (adapter.implementation.oauth !== 'IMPLEMENTED') {
      res.json({ ...base, live: false, detail: new ProviderNotImplementedError(adapter, 'oauth').message });
      return;
    }

    try {
      const identity = await bindProvider(integration.platform).validate({
        accessToken: decryptSecret(integration.accessTokenEnc),
        fetchImpl: fetch as never,
      });
      res.json({ ...base, live: true, detail: `${adapter.label} answered as ${identity.name}.` });
    } catch (error) {
      const message = (error as Error).message.slice(0, 500);
      await prisma.integration.update({
        where: { id: integration.id },
        data: { status: IntegrationStatus.ERROR, lastError: message },
      });
      res.json({ ...base, status: IntegrationStatus.ERROR, live: false, detail: message });
    }
  }),
);

integrationsRouter.post(
  '/:id/disconnect',
  requireAgency,
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertWritable(actor);

    const existing = await prisma.integration.findFirst({
      where: { id: req.params.id, organizationId: orgId(actor) },
      select: { id: true, platform: true },
    });
    if (!existing) throw notFound('Integration');

    await prisma.integration.update({
      where: { id: existing.id },
      data: {
        status: IntegrationStatus.DISCONNECTED,
        credentials: Prisma.DbNull,
        accountName: null,
        accountId: null,
        lastError: null,
        accessTokenEnc: null,
        refreshTokenEnc: null,
        tokenExpiresAt: null,
        tokenFingerprint: null,
      },
    });

    await recordAudit({ actor, action: 'integration.disconnect', entity: 'Integration', entityId: existing.id, ip: req.ip });
    res.json({ ok: true });
  }),
);

integrationsRouter.post(
  '/:id/sync',
  requireAgency,
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const integration = await prisma.integration.findFirst({
      where: { id: req.params.id, organizationId: orgId(actor) },
    });
    if (!integration) throw notFound('Integration');

    if (integration.status !== IntegrationStatus.CONNECTED) {
      throw badRequest('This account is not connected, so there is nothing to sync');
    }

    const adapter = adapterFor(integration.platform);

    /*
     * This route used to call `adapter.fetchMetrics()` — which returns an empty
     * array for every adapter — and then answer `{ ok: true }`. Nothing was
     * fetched and nothing was written, so an operator pressing Sync was told it
     * worked and watched the same numbers sit there.
     *
     * Meta now ingests for real. Everything else still says so plainly.
     */
    if (!METRIC_SYNC_PLATFORMS.includes(integration.platform)) {
      res.status(501).json({
        error: {
          code: 'METRICS_SYNC_NOT_IMPLEMENTED',
          message:
            `Metric ingestion for ${adapter.label} is not implemented yet ` +
            `(${adapter.implementation.metrics}), so there is nothing to sync. ` +
            'No figures on this account come from the provider.',
          details: { platform: integration.platform, implementation: adapter.implementation },
        },
      });
      return;
    }

    /*
     * Dispatched on the platform rather than branched inside one sync: Meta and
     * Google Ads read entirely different APIs, and the shared part — the run
     * record and the snapshot grain — is shared already.
     */
    const result = integration.platform === Platform.GOOGLE_ADS
      ? await syncGoogleAdsMetrics({
        prisma,
        integrationId: integration.id,
        organizationId: orgId(actor),
        fetchImpl: fetch as unknown as Parameters<typeof syncGoogleAdsMetrics>[0]['fetchImpl'],
      })
      : await syncMetaMetrics({
        prisma,
        integrationId: integration.id,
        organizationId: orgId(actor),
        fetchImpl: fetch as unknown as Parameters<typeof syncMetaMetrics>[0]['fetchImpl'],
      });
    if (!result) throw notFound('Integration');

    await recordAudit({
      actor,
      action: 'sync.finish',
      entity: 'Integration',
      entityId: integration.id,
      meta: { status: result.status, campaignsRead: result.campaignsRead, daysWritten: result.daysWritten },
      ip: req.ip,
    });

    // A failed run answers 200 with the failure described: the operator needs
    // to read what happened, and the run row already records it.
    res.json(result);
  }),
);

/**
 * The campaigns running in the connected Google Ads account.
 *
 * Read-only, and unattributed on purpose: it answers "what is live in this ad
 * account", which is a different question from "how did what NORIVA published
 * perform". The second is answered by the snapshots `POST /:id/sync` writes,
 * and mixing the two would file a campaign created in Google Ads Manager under
 * a local campaign it has nothing to do with.
 *
 * Ratios are absent for the same reason they are absent everywhere else: the
 * analytics layer derives them and refuses the ones it cannot.
 */
integrationsRouter.get(
  '/:id/google-ads/campaigns',
  validateParams(idParam),
  validateQuery(z.object({
    since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const query = req.query as { since?: string; until?: string };

    // Tenant scoping is the `organizationId` filter inside the service; a
    // connection belonging to another organisation is simply not found.
    const integration = await prisma.integration.findFirst({
      where: { id: req.params.id, organizationId: orgId(actor), platform: Platform.GOOGLE_ADS },
      select: { id: true },
    });
    if (!integration) throw notFound('Integration');

    const now = new Date();
    const since = query.since ?? new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
    const until = query.until ?? now.toISOString().slice(0, 10);

    try {
      res.json(await listGoogleAdsCampaigns({
        prisma,
        integrationId: integration.id,
        organizationId: orgId(actor),
        since,
        until,
        fetchImpl: fetch as unknown as Parameters<typeof listGoogleAdsCampaigns>[0]['fetchImpl'],
      }));
    } catch (error) {
      /*
       * Google's own words, mapped to an explanation an operator can act on,
       * and never the raw error: a Google Ads failure message can carry request
       * identifiers and account ids that have no business on a screen.
       */
      if (error instanceof GoogleAdsError) {
        res.status(error.failure === 'NOT_AUTHORIZED' ? 403 : 502).json({
          error: { code: error.failure, message: error.explanation },
        });
        return;
      }
      throw error;
    }
  }),
);

// ------------------------------------------------------------------ subscriptions

export const subscriptionsRouter: Router = Router();
subscriptionsRouter.use(requireAuth);

subscriptionsRouter.get(
  '/plans',
  asyncHandler(async (_req, res) => {
    const plans = await prisma.plan.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } });
    res.json({
      plans: plans.map((plan) => ({
        ...plan,
        priceMonthly: Number(plan.priceMonthly.toString()),
        priceYearly: Number(plan.priceYearly.toString()),
      })),
    });
  }),
);

subscriptionsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const clientId = resolveClientId(actor, undefined);

    const items = await prisma.subscription.findMany({
      where: { organizationId: orgId(actor), ...(clientId ? { clientId } : {}) },
      include: { plan: true, client: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ items });
  }),
);

/** Current usage against the plan's limits. */
subscriptionsRouter.get(
  '/usage',
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const organizationId = orgId(actor);
    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));

    const [clients, users, campaigns, aiThisMonth, media, integrations, subscription] = await Promise.all([
      prisma.client.count({ where: { organizationId } }),
      prisma.user.count({ where: { organizationId } }),
      prisma.campaign.count({ where: { organizationId } }),
      prisma.aiUsage.count({ where: { organizationId, createdAt: { gte: monthStart } } }),
      prisma.media.aggregate({ where: { organizationId }, _sum: { sizeBytes: true } }),
      prisma.integration.count({ where: { organizationId, status: IntegrationStatus.CONNECTED } }),
      prisma.subscription.findFirst({
        where: { organizationId, clientId: null },
        include: { plan: true },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const plan = subscription?.plan ?? (await prisma.plan.findFirst({ orderBy: { sortOrder: 'asc' } }));

    res.json({
      plan: plan
        ? { ...plan, priceMonthly: Number(plan.priceMonthly.toString()), priceYearly: Number(plan.priceYearly.toString()) }
        : null,
      subscription,
      usage: {
        clients,
        users,
        campaigns,
        aiThisMonth,
        storageMb: Number(((media._sum.sizeBytes ?? 0) / (1024 * 1024)).toFixed(2)),
        integrations,
      },
      limits: plan
        ? {
            clients: plan.maxClients,
            users: plan.maxUsers,
            campaigns: plan.maxCampaigns,
            aiThisMonth: plan.maxAiPerMonth,
            storageMb: plan.maxStorageMb,
            integrations: plan.maxIntegrations,
          }
        : null,
      // Nothing here has been charged: no payment provider is configured.
      billing: { provider: null, status: 'not_configured' },
    });
  }),
);

// ------------------------------------------------------------------ users

export const usersRouter: Router = Router();
usersRouter.use(requireAuth, requireAgency);

usersRouter.get(
  '/',
  validateQuery(paginationQuery.extend({ role: z.nativeEnum(Role).optional(), clientId: z.string().max(40).optional() })),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const query = req.query as unknown as z.infer<typeof paginationQuery> & { role?: Role; clientId?: string };

    const where: Prisma.UserWhereInput = {
      organizationId: orgId(actor),
      ...(query.role ? { role: query.role } : {}),
      ...(query.clientId ? { clientId: query.clientId } : {}),
      ...(query.search
        ? { OR: [{ name: { contains: query.search, mode: 'insensitive' } }, { email: { contains: query.search, mode: 'insensitive' } }] }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.user.findMany({
        where,
        ...paginate(query),
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, name: true, email: true, role: true, isActive: true, locale: true,
          lastLoginAt: true, createdAt: true, client: { select: { id: true, name: true } },
        },
      }),
      prisma.user.count({ where }),
    ]);

    res.json(pageResult(items, total, query));
  }),
);

const createUserSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email().max(255),
  password: z.string().min(1).superRefine((value, ctx) => {
    for (const problem of passwordProblems(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Password ${problem}` });
    }
  }),
  role: z.nativeEnum(Role),
  clientId: z.string().max(40).nullish(),
  locale: z.nativeEnum(Language).default(Language.EN),
});

usersRouter.post(
  '/',
  requireManager,
  validateBody(createUserSchema),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const body = req.body as z.infer<typeof createUserSchema>;

    // Only a super admin may mint another super admin.
    if (body.role === Role.SUPER_ADMIN && actor.role !== Role.SUPER_ADMIN) {
      throw badRequest('Only a super admin can create another super admin');
    }
    const needsClient = body.role === Role.CLIENT_ADMIN || body.role === Role.CLIENT_USER;
    if (needsClient && !body.clientId) throw badRequest('Client portal users must be attached to a client');

    if (body.clientId) {
      const client = await prisma.client.findFirst({
        where: { id: body.clientId, organizationId: orgId(actor) },
        select: { id: true },
      });
      if (!client) throw notFound('Client');
    }

    if (await prisma.user.findUnique({ where: { email: body.email }, select: { id: true } })) {
      throw conflict('An account with that email already exists');
    }

    const user = await prisma.user.create({
      data: {
        name: body.name,
        email: body.email,
        passwordHash: await hashPassword(body.password),
        role: body.role,
        locale: body.locale,
        organizationId: orgId(actor),
        clientId: needsClient ? body.clientId ?? null : null,
      },
      select: { id: true, name: true, email: true, role: true, isActive: true, clientId: true, createdAt: true },
    });

    await recordAudit({ actor, action: 'user.create', entity: 'User', entityId: user.id, ip: req.ip });
    res.status(201).json({ user });
  }),
);

usersRouter.patch(
  '/:id',
  requireManager,
  validateParams(idParam),
  validateBody(
    z.object({
      name: z.string().trim().min(2).max(120).optional(),
      role: z.nativeEnum(Role).optional(),
      isActive: z.boolean().optional(),
      clientId: z.string().max(40).nullish(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const body = req.body as { role?: Role; isActive?: boolean; name?: string; clientId?: string | null };

    const existing = await prisma.user.findFirst({
      where: { id: req.params.id, organizationId: orgId(actor) },
      select: { id: true, role: true },
    });
    if (!existing) throw notFound('User');

    if (existing.id === actor.id && body.isActive === false) {
      throw badRequest('You cannot deactivate your own account');
    }
    if (body.role === Role.SUPER_ADMIN && actor.role !== Role.SUPER_ADMIN) {
      throw badRequest('Only a super admin can grant super admin');
    }

    const user = await prisma.user.update({
      where: { id: existing.id },
      data: body,
      select: { id: true, name: true, email: true, role: true, isActive: true, clientId: true },
    });

    // Deactivating a user ends their sessions immediately.
    if (body.isActive === false) await prisma.session.deleteMany({ where: { userId: user.id } });

    await recordAudit({ actor, action: 'user.update', entity: 'User', entityId: user.id, ip: req.ip });
    res.json({ user });
  }),
);
