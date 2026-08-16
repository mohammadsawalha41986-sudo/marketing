/**
 * /api/storage — is the object really there?
 *
 * Every other route reaches storage through a database row, so a successful
 * read only ever proves that a row and an object agree. It cannot answer the
 * question an acceptance test actually needs answered — *is this key present in
 * the bucket, and are these the same bytes as before* — and it cannot be asked
 * about a key the database has never seen.
 *
 * This goes straight to the StorageProvider and reports the driver, existence,
 * length and a SHA-256. A digest rather than content, deliberately: this is an
 * operations endpoint, not a second way to read tenant media.
 *
 * Access follows the tenant boundary that already lives in the key itself.
 * Object keys are `clients/<clientId>/...`, so an agency admin may ask about
 * their own clients' objects and nobody else's — a size and a digest are still
 * more than another agency should learn about a file they do not own. The
 * unscoped form, with no key, stays owner-only.
 */

import { Router } from 'express';
import { Role } from '@prisma/client';
import { createHash } from 'node:crypto';
import { z } from 'zod';

import { prisma } from '../lib/prisma.js';
import { asyncHandler, forbidden } from '../lib/errors.js';
import { actorOf, requireAuth } from '../middleware/auth.js';
import { validateQuery } from '../middleware/validate.js';
import { crossTenant } from '../lib/scope.js';
import { storage, storageStatus } from '../services/storage/index.js';

export const storageRouter: Router = Router();
storageRouter.use(requireAuth);

storageRouter.get(
  '/diagnostics',
  validateQuery(z.object({ key: z.string().max(400).optional() })),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const key = (req.query as { key?: string }).key;

    if (!key) {
      // Nothing to scope to, so this form reports deployment-wide state only.
      crossTenant(actor);
    } else if (actor.role !== Role.SUPER_ADMIN) {
      const owner = /^clients\/([^/]+)\//.exec(key)?.[1];
      const client = owner
        ? await prisma.client.findFirst({
            where: { id: owner, organizationId: actor.organizationId ?? '' },
            select: { id: true },
          })
        : null;
      if (!client) throw forbidden('That storage key does not belong to your organisation');
    }

    const status = storageStatus();

    // Which variables are set, never what they are set to.
    const variables = {
      S3_ENDPOINT: Boolean(process.env.S3_ENDPOINT),
      S3_BUCKET: Boolean(process.env.S3_BUCKET),
      S3_ACCESS_KEY_ID: Boolean(process.env.S3_ACCESS_KEY_ID),
      S3_SECRET_ACCESS_KEY: Boolean(process.env.S3_SECRET_ACCESS_KEY),
      S3_REGION: process.env.S3_REGION ?? null,
    };

    // The bucket and endpoint host say *where* objects go, which an operator
    // needs. The access key and the secret never leave the process.
    const endpointHost = (() => {
      try {
        return process.env.S3_ENDPOINT ? new URL(process.env.S3_ENDPOINT).host : null;
      } catch {
        return null;
      }
    })();

    /*
     * Every failure here is reported, never thrown.
     *
     * This is the endpoint an operator opens *because* storage is misbehaving.
     * Answering 500 "Something went wrong" when the bucket is unreachable would
     * make the diagnostic tool fail in exactly the situation it exists for —
     * which is what it did the first time it met a TLS handshake rejection.
     */
    const object = key
      ? await (async () => {
          const base = { key, exists: null as boolean | null, sizeBytes: null as number | null, sha256: null as string | null };

          let exists: boolean;
          try {
            exists = storage.exists ? await storage.exists(key) : false;
          } catch (error) {
            return { ...base, reachable: false, error: (error as Error).message };
          }

          if (!exists) return { ...base, exists: false, reachable: true, error: null };

          try {
            const bytes = await storage.read!(key);
            return {
              key,
              exists: true,
              reachable: true,
              sizeBytes: bytes.byteLength,
              sha256: createHash('sha256').update(bytes).digest('hex'),
              error: null,
            };
          } catch (error) {
            // Present but unreadable is its own answer — a permissions problem
            // reads completely differently from a missing object.
            return { ...base, exists: true, reachable: true, error: (error as Error).message };
          }
        })()
      : null;

    res.json({
      driver: status.driver,
      persistent: status.persistent,
      configured: status.configured,
      reason: status.reason,
      bucket: process.env.S3_BUCKET ?? null,
      endpointHost,
      variables,
      object,
    });
  }),
);
