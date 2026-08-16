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
import { lookup } from 'node:dns/promises';
import { connect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { z } from 'zod';

import { prisma } from '../lib/prisma.js';
import { asyncHandler, forbidden, storageNotConfigured } from '../lib/errors.js';
import { actorOf, requireAgency, requireAuth } from '../middleware/auth.js';
import { validateBody, validateQuery } from '../middleware/validate.js';
import { crossTenant } from '../lib/scope.js';
import { storage, storageStatus } from '../services/storage/index.js';
import { S3Storage, s3ConfigFrom } from '../services/storage/s3.js';
import type { Actor } from '../lib/scope.js';

/**
 * The probe reports deployment-wide networking, not tenant data, so it is
 * limited to administrators — but not to the owner alone, because the agency
 * admin running a deployment is the person who needs it.
 */
function crossTenantOrAgencyAdmin(actor: Actor): void {
  if (actor.role !== Role.SUPER_ADMIN && actor.role !== Role.AGENCY_ADMIN) {
    throw forbidden('Storage probes are limited to administrators');
  }
}

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

/**
 * Network-layer probe, run from inside the production runtime.
 *
 * The point is to separate failures that all look identical from outside: DNS,
 * TCP, TLS, authentication, authorization, and a missing bucket each need a
 * completely different fix, and an upload that returns 502 tells you none of
 * them. Each layer is exercised in order and reported separately.
 *
 * Every operation is read-only — DNS lookup, a TCP connect, a TLS handshake,
 * HeadBucket and a capped ListObjectsV2. Nothing is uploaded, modified or
 * deleted.
 *
 * `accountId` lets an operator test a candidate endpoint *before* changing
 * production configuration, which is the difference between verifying a fix and
 * deploying a guess. It is deliberately not a free-form URL: the value must be
 * 32 hex characters and is substituted into a fixed Cloudflare hostname, so this
 * cannot be turned into a way to make the server fetch arbitrary addresses.
 */
storageRouter.post(
  '/probe',
  requireAgency,
  validateBody(
    z.object({
      accountId: z
        .string()
        .regex(/^[0-9a-f]{32}$/, 'An R2 account id is 32 lowercase hex characters')
        .optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    crossTenantOrAgencyAdmin(actorOf(req));

    const config = s3ConfigFrom();
    if (!config) throw storageNotConfigured('Object storage is not configured, so there is nothing to probe.');

    const { accountId } = req.body as { accountId?: string };
    const endpoint = accountId ? `https://${accountId}.r2.cloudflarestorage.com` : config.endpoint;
    const host = new URL(endpoint).host;

    const steps: Array<Record<string, unknown>> = [];
    const record = (layer: string, ok: boolean, detail: Record<string, unknown>) =>
      steps.push({ layer, ok, ...detail });

    // ------------------------------------------------------------------ DNS
    let addresses: string[] = [];
    try {
      const resolved = await lookup(host, { all: true });
      addresses = resolved.map((entry) => entry.address);
      record('DNS', true, { host, addresses });
    } catch (error) {
      record('DNS', false, { host, error: (error as Error).message });
      return res.json({ endpointHost: host, bucket: config.bucket, region: config.region, steps, failedAt: 'DNS' });
    }

    // ------------------------------------------------------------------ TCP
    const tcp = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const socket = connect({ host, port: 443, timeout: 10_000 });
      socket.once('connect', () => {
        socket.destroy();
        resolve({ ok: true });
      });
      socket.once('timeout', () => {
        socket.destroy();
        resolve({ ok: false, error: 'timed out' });
      });
      socket.once('error', (error) => {
        socket.destroy();
        resolve({ ok: false, error: error.message });
      });
    });
    record('TCP', tcp.ok, { port: 443, ...(tcp.error ? { error: tcp.error } : {}) });
    if (!tcp.ok) {
      return res.json({ endpointHost: host, bucket: config.bucket, region: config.region, steps, failedAt: 'TCP' });
    }

    // ------------------------------------------------------------------ TLS
    const tls = await new Promise<{ ok: boolean; protocol?: string; cipher?: string; subject?: string; error?: string }>(
      (resolve) => {
        // servername is set explicitly: Cloudflare provisions a certificate per
        // R2 account, so SNI is what decides whether the handshake is answered
        // at all. An account that does not exist is refused here, before any
        // credential is offered — which is why an auth error and a wrong
        // endpoint look nothing alike once you look at this layer.
        const socket = tlsConnect({ host, port: 443, servername: host, timeout: 10_000 }, () => {
          const cert = socket.getPeerCertificate();
          // A certificate CN can legitimately be multi-valued; the probe only
          // needs a readable identity for the host that answered.
          const cn = cert?.subject?.CN;
          resolve({
            ok: true,
            protocol: socket.getProtocol() ?? undefined,
            cipher: socket.getCipher()?.name,
            subject: Array.isArray(cn) ? cn.join(', ') : cn,
          });
          socket.destroy();
        });
        socket.once('error', (error) => {
          socket.destroy();
          resolve({ ok: false, error: error.message });
        });
        socket.once('timeout', () => {
          socket.destroy();
          resolve({ ok: false, error: 'timed out' });
        });
      },
    );
    record('TLS', tls.ok, tls.ok ? { protocol: tls.protocol, cipher: tls.cipher, certificateCN: tls.subject } : { error: tls.error });
    if (!tls.ok) {
      return res.json({ endpointHost: host, bucket: config.bucket, region: config.region, steps, failedAt: 'TLS' });
    }

    // ----------------------------------------------- authenticated, read-only
    const probe = new S3Storage({ ...config, endpoint });

    try {
      const head = await probe.headBucket();
      // 200 the bucket is reachable; 403 credentials rejected or not permitted;
      // 404 the bucket name is wrong. All three are answers, none is a crash.
      record('HeadBucket', head.ok, {
        status: head.status,
        meaning:
          head.status === 200
            ? 'the bucket exists and these credentials can reach it'
            : head.status === 403
              ? 'the endpoint and bucket are reachable but the credentials were rejected'
              : head.status === 404
                ? 'reached the account, but no bucket by that name'
                : `unexpected status ${head.status}`,
      });

      const list = await probe.listObjects(5);
      record('ListObjectsV2', list.status === 200, {
        status: list.status,
        keyCount: list.keys.length,
        sampleKeys: list.keys.slice(0, 5),
        ...(list.status === 200 ? {} : { body: list.body }),
      });
    } catch (error) {
      record('S3', false, { error: (error as Error).message });
    }

    const failed = steps.find((step) => step.ok === false);
    res.json({
      endpointHost: host,
      bucket: config.bucket,
      region: config.region,
      probedCandidate: Boolean(accountId),
      steps,
      failedAt: failed ? failed.layer : null,
    });
  }),
);
