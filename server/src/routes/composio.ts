/**
 * Composio connections, per restaurant.
 *
 * Mounted at /api/composio. Every route resolves the restaurant through
 * `resolveClientId` — a restaurant user is pinned to their own restaurant and
 * asking for another answers 404 — and then checks the restaurant belongs to
 * the caller's organisation. The Composio user id is derived from that checked
 * id inside the service; no route accepts one.
 *
 * Restaurant owners and managers may connect and disconnect their own
 * accounts (`integrations.manage`); this is what lets an agency invite a
 * restaurant to connect itself rather than collecting its passwords.
 */

import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../lib/prisma.js';
import { AppError, asyncHandler, notFound } from '../lib/errors.js';
import { actorOf, requireAuth } from '../middleware/auth.js';
import { validateBody, validateParams } from '../middleware/validate.js';
import { idParam } from '../lib/http.js';
import { isClientUser, orgId, resolveClientId, scopeWhere, type Actor } from '../lib/scope.js';
import { assertCan } from '../lib/rbac.js';
import { env } from '../env.js';
import { recordAudit } from '../services/audit.js';
import { ComposioError, type ComposioFetch } from '../services/composio/client.js';
import {
  ComposioRequestError, catalog, clientFor, disconnect, reconcile, serializeConnection, startConnection, testConnection,
} from '../services/composio/service.js';
import { usageSummary } from '../services/composio/usage.js';

export const composioRouter: Router = Router();
composioRouter.use(requireAuth);

/*
 * The global fetch, read per call rather than captured at import, so a test
 * that stubs it is observed — the same reason the integrations router reads it
 * inside each handler.
 */
const fetchNow = (): ComposioFetch => ((...args: Parameters<ComposioFetch>) => fetch(...(args as Parameters<typeof fetch>))) as ComposioFetch;

/** Composio failures mapped to what the operator can do about them. */
function rethrow(error: unknown): never {
  if (error instanceof ComposioRequestError) throw new AppError(error.status, 'COMPOSIO_REQUEST', error.message);
  if (error instanceof ComposioError) {
    const status = error.kind === 'NOT_CONFIGURED' ? 503 : error.kind === 'RATE_LIMIT' ? 429 : 502;
    const message = error.kind === 'AUTH'
      ? 'Composio rejected this deployment\'s API key. An administrator must replace COMPOSIO_API_KEY.'
      : error.message;
    throw new AppError(status, `COMPOSIO_${error.kind}`, message);
  }
  throw error;
}

async function restaurant(actor: Actor, requested: string) {
  const clientId = resolveClientId(actor, requested)!;
  const client = await prisma.client.findFirst({
    where: { id: clientId, organizationId: orgId(actor) },
    select: { id: true, businessName: true },
  });
  if (!client) throw notFound('Client');
  return client;
}

async function ownedConnection(actor: Actor, id: string) {
  const row = await prisma.composioConnection.findFirst({ where: { id, ...scopeWhere(actor) } });
  if (!row) throw notFound('Connection');
  return row;
}

function returnUrlFor(actor: Actor, clientId: string): string {
  // Back to the screen the person started from; the client id only says which
  // restaurant to re-read — the server re-derives everything from it.
  return isClientUser(actor)
    ? `${env.APP_URL}/client/integrations?composio=returned`
    : `${env.APP_URL}/app/integrations?composio=returned&client=${encodeURIComponent(clientId)}`;
}

composioRouter.get(
  '/catalog',
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertCan(actor, 'integrations.view');
    const client = clientFor({ prisma, organizationId: orgId(actor), clientId: null, fetchImpl: fetchNow() });
    try {
      res.json(await catalog(client));
    } catch (error) {
      rethrow(error);
    }
  }),
);

const clientParam = z.object({ clientId: z.string().min(1).max(40) });

composioRouter.get(
  '/:clientId/connections',
  validateParams(clientParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertCan(actor, 'integrations.view');
    const client = await restaurant(actor, req.params.clientId!);
    const rows = await prisma.composioConnection.findMany({
      where: { organizationId: orgId(actor), clientId: client.id },
      orderBy: [{ toolkit: 'asc' }, { createdAt: 'asc' }],
    });
    res.json({ items: rows.map(serializeConnection) });
  }),
);

composioRouter.post(
  '/:clientId/connections',
  validateParams(clientParam),
  validateBody(z.object({
    authConfigId: z.string().min(1).max(80),
    alias: z.string().trim().max(80).optional(),
  })),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertCan(actor, 'integrations.manage');
    const client = await restaurant(actor, req.params.clientId!);
    const body = req.body as { authConfigId: string; alias?: string };
    const composio = clientFor({ prisma, organizationId: orgId(actor), clientId: client.id, fetchImpl: fetchNow() });

    try {
      const result = await startConnection({
        prisma,
        client: composio,
        organizationId: orgId(actor),
        clientId: client.id,
        authConfigId: body.authConfigId,
        alias: body.alias || undefined,
        returnUrl: returnUrlFor(actor, client.id),
        actorId: actor.id,
      });
      await recordAudit({
        actor, action: 'composio.connect', entity: 'ComposioConnection', entityId: result.connectionId,
        meta: { clientId: client.id, authConfigId: body.authConfigId }, ip: req.ip,
      });
      // The hosted Composio page; it carries no secret of ours.
      res.status(201).json(result);
    } catch (error) {
      rethrow(error);
    }
  }),
);

composioRouter.post(
  '/:clientId/sync',
  validateParams(clientParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertCan(actor, 'integrations.view');
    const client = await restaurant(actor, req.params.clientId!);
    const composio = clientFor({ prisma, organizationId: orgId(actor), clientId: client.id, fetchImpl: fetchNow() });
    try {
      const result = await reconcile({ prisma, client: composio, organizationId: orgId(actor), clientId: client.id });
      const rows = await prisma.composioConnection.findMany({
        where: { organizationId: orgId(actor), clientId: client.id },
        orderBy: [{ toolkit: 'asc' }, { createdAt: 'asc' }],
      });
      res.json({ ...result, items: rows.map(serializeConnection) });
    } catch (error) {
      rethrow(error);
    }
  }),
);

composioRouter.post(
  '/connections/:id/test',
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertCan(actor, 'integrations.view');
    const row = await ownedConnection(actor, req.params.id!);
    const composio = clientFor({ prisma, organizationId: row.organizationId, clientId: row.clientId, fetchImpl: fetchNow() });
    try {
      const updated = await testConnection({ prisma, client: composio, row });
      await recordAudit({
        actor, action: 'composio.test', entity: 'ComposioConnection', entityId: row.id,
        meta: { remoteStatus: updated.remoteStatus, verification: updated.verification, error: updated.lastErrorKind }, ip: req.ip,
      });
      res.json(serializeConnection(updated));
    } catch (error) {
      rethrow(error);
    }
  }),
);

composioRouter.post(
  '/connections/:id/reconnect',
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertCan(actor, 'integrations.manage');
    const row = await ownedConnection(actor, req.params.id!);
    const composio = clientFor({ prisma, organizationId: row.organizationId, clientId: row.clientId, fetchImpl: fetchNow() });
    try {
      /*
       * A fresh login for the same auth config. The old connection keeps
       * working (or not) until the new one is ACTIVE, and is removed then —
       * reconnecting never leaves a restaurant with fewer working accounts
       * than it started with.
       */
      const result = await startConnection({
        prisma,
        client: composio,
        organizationId: row.organizationId,
        clientId: row.clientId,
        authConfigId: row.authConfigId,
        alias: row.alias ?? undefined,
        returnUrl: returnUrlFor(actor, row.clientId),
        actorId: actor.id,
        replacesId: row.id,
      });
      await recordAudit({
        actor, action: 'composio.reconnect', entity: 'ComposioConnection', entityId: row.id,
        meta: { replacement: result.connectionId }, ip: req.ip,
      });
      res.status(201).json(result);
    } catch (error) {
      rethrow(error);
    }
  }),
);

composioRouter.delete(
  '/connections/:id',
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertCan(actor, 'integrations.manage');
    const row = await ownedConnection(actor, req.params.id!);
    const composio = clientFor({ prisma, organizationId: row.organizationId, clientId: row.clientId, fetchImpl: fetchNow() });
    try {
      await disconnect({ prisma, client: composio, row });
      await recordAudit({
        actor, action: 'composio.disconnect', entity: 'ComposioConnection', entityId: row.id,
        meta: { clientId: row.clientId, toolkit: row.toolkit }, ip: req.ip,
      });
      res.json({ ok: true });
    } catch (error) {
      rethrow(error);
    }
  }),
);

/** Connection History: who connected, tested, reconnected — from the audit log. */
composioRouter.get(
  '/connections/:id/history',
  validateParams(idParam),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertCan(actor, 'integrations.view');
    const row = await ownedConnection(actor, req.params.id!);
    const events = await prisma.auditLog.findMany({
      where: { organizationId: row.organizationId, entity: 'ComposioConnection', entityId: row.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, action: true, meta: true, createdAt: true, user: { select: { name: true } } },
    });
    res.json({ items: events });
  }),
);

/** Consumption & cost: the agency's view across all of its restaurants. */
composioRouter.get(
  '/usage',
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    assertCan(actor, 'usage.view');
    res.json(await usageSummary({ prisma, organizationId: orgId(actor) }));
  }),
);
