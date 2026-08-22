/**
 * Smaller routers: notifications, integrations, subscriptions and users.
 * Grouped because each is a handful of endpoints over a single model.
 */

import { Router } from 'express';
import { IntegrationStatus, Language, Platform, Prisma, Role } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '../lib/prisma.js';
import { asyncHandler, badRequest, conflict, notFound } from '../lib/errors.js';
import { actorOf, requireAgency, requireAuth, requireManager } from '../middleware/auth.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validate.js';
import { idParam, pageResult, paginate, paginationQuery } from '../lib/http.js';
import { assertWritable, orgId, resolveClientId } from '../lib/scope.js';
import {
  adapterFor, providerReadiness, allAdapters, supportsOAuth,
  ProviderNotConfiguredError, ProviderNotImplementedError,
} from '../services/integrations/index.js';
import { beginAuthorization, completeCallback, selectAccounts } from '../services/integrations/connect-flow.js';
import { validateToken } from '../services/integrations/meta.js';
import { METRIC_SYNC_PLATFORMS, syncMetaMetrics } from '../services/integrations/metric-sync.js';
import { decryptSecret } from '../lib/crypto.js';
import { env } from '../env.js';
import { hashPassword, passwordProblems } from '../lib/password.js';
import { recordAudit } from '../services/audit.js';
import { aiStatus } from '../services/ai/index.js';

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
 * The provider's redirect back, on its own unauthenticated router.
 *
 * Mounted *before* `requireAuth` deliberately. This request is a top-level
 * browser navigation initiated by Meta, and depending on the cookie's SameSite
 * policy the session may not travel with it — gating it on a session would
 * break the flow for a subset of users in a way that is miserable to diagnose.
 *
 * It is not unprotected. The `state` parameter is the authorisation: minted
 * against one organization, one client and one platform, hashed at rest,
 * single-use and short-lived (`oauth-state.ts`). `consumeState` is what decides
 * whose connection this is — nothing here reads a tenant from the query string.
 */
export const oauthCallbackRouter: Router = Router();

/**
 * Where the browser is sent afterwards.
 *
 * The result is carried as query parameters, never the code or the token. A
 * failure sends the operator back to the same screen with the provider's own
 * message rather than to a dead end.
 */
function callbackRedirect(outcome: { ok: true; integrationId: string } | { ok: false; reason: string }): string {
  const url = new URL('/app/integrations', env.APP_URL);
  if (outcome.ok) {
    url.searchParams.set('connected', 'meta');
    url.searchParams.set('integration', outcome.integrationId);
  } else {
    url.searchParams.set('error', outcome.reason.slice(0, 300));
  }
  return url.toString();
}

oauthCallbackRouter.get(
  '/meta/callback',
  validateQuery(
    z.object({
      // Meta sends either (code, state) or its own error triple.
      code: z.string().min(1).max(2000).optional(),
      state: z.string().min(1).max(200).optional(),
      error: z.string().max(200).optional(),
      error_reason: z.string().max(200).optional(),
      error_description: z.string().max(500).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const query = req.query as {
      code?: string; state?: string; error?: string; error_description?: string;
    };

    // The operator pressed Cancel on Meta's dialog. Not an error worth a 500.
    if (query.error) {
      res.redirect(callbackRedirect({ ok: false, reason: query.error_description ?? query.error }));
      return;
    }
    if (!query.code || !query.state) {
      res.redirect(callbackRedirect({ ok: false, reason: 'Meta returned no authorization code' }));
      return;
    }

    try {
      const result = await completeCallback({
        platform: Platform.FACEBOOK,
        state: query.state,
        code: query.code,
        fetchImpl: fetch as unknown as Parameters<typeof completeCallback>[0]['fetchImpl'],
      });
      res.redirect(callbackRedirect({ ok: true, integrationId: result.integrationId }));
    } catch (error) {
      // completeCallback has already parked the integration in ERROR with the
      // reason. Provider messages never carry the code or the token.
      res.redirect(callbackRedirect({ ok: false, reason: (error as Error).message }));
    }
  }),
);

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
          canConnect: supportsOAuth(adapter) && readiness.state === 'READY',
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

/**
 * Get discovered accounts for an integration (before selection).
 *
 * GET /api/integrations/:integrationId/accounts
 *
 * Returns the integration and all discovered accounts with their selection status.
 * Tokens are never exposed in the response. Used by the account-selection UI.
 */
integrationsRouter.get(
  '/:integrationId/accounts',
  requireAgency,
  validateParams(z.object({ integrationId: z.string().min(1).max(40) })),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const { integrationId } = req.params as { integrationId: string };

    const integration = await prisma.integration.findFirst({
      where: { id: integrationId, organizationId: orgId(actor) },
      select: {
        id: true,
        platform: true,
        status: true,
        accountName: true,
        accountId: true,
        clientId: true,
        client: { select: { id: true, name: true } },
        accounts: {
          select: {
            id: true,
            kind: true,
            externalId: true,
            name: true,
            username: true,
            currency: true,
            timezone: true,
            parentExternalId: true,
            selected: true,
          },
        },
      },
    });

    if (!integration) throw notFound('Integration');
    res.json(integration);
  }),
);

/**
 * Select which accounts to attach to this integration.
 *
 * POST /api/integrations/:integrationId/select
 *
 * Request body:
 * {
 *   "accountIds": ["...", "..."]
 * }
 *
 * Updates the `selected` flag on IntegrationAccount rows.
 * Transitions the Integration to CONNECTED if any accounts are selected,
 * or to DISCONNECTED if none are selected.
 * Only accounts belonging to this integration can be selected (enforced in service).
 */
integrationsRouter.post(
  '/:integrationId/select',
  requireAgency,
  validateParams(z.object({ integrationId: z.string().min(1).max(40) })),
  validateBody(z.object({ accountIds: z.array(z.string().min(1).max(40)) })),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const { integrationId } = req.params as { integrationId: string };
    const { accountIds } = req.body as { accountIds: string[] };

    // Verify the integration belongs to this organization
    const integration = await prisma.integration.findFirst({
      where: { id: integrationId, organizationId: orgId(actor) },
      select: { id: true, clientId: true, platform: true },
    });
    if (!integration) throw notFound('Integration');

    assertWritable(actor);

    const result = await selectAccounts({
      integrationId,
      organizationId: orgId(actor),
      accountIds,
    });

    await recordAudit({
      actor,
      action: 'integration.select-accounts',
      entity: 'Integration',
      entityId: integrationId,
      ip: req.ip,
    });

    res.json(result);
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
     * "Not built" comes first because it is not fixable by configuration: a
     * Google Ads adapter with all four variables set is configured and still
     * cannot start a flow. Reporting NOT_CONFIGURED there would send an
     * operator to add variables that are already present.
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
          select: {
            id: true, kind: true, externalId: true, name: true, username: true,
            currency: true, timezone: true, parentExternalId: true, selected: true,
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
 * Ask the provider whether this connection still works.
 *
 * A stored token is not a connection. This spends a real API call on `/me` so
 * the answer comes from Meta rather than from our own status column, and parks
 * the integration in ERROR when the provider rejects the credential — which is
 * how an expired token stops being a mystery.
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
      const identity = await validateToken({
        accessToken: decryptSecret(integration.accessTokenEnc),
        fetchImpl: fetch as unknown as Parameters<typeof validateToken>[0]['fetchImpl'],
      });
      res.json({ ...base, live: true, detail: `Meta answered as ${identity.name}.` });
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

    const result = await syncMetaMetrics({
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
