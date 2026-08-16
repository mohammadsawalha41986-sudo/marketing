/**
 * OAuth state and PKCE.
 *
 * The state parameter is the only thing standing between an OAuth callback and
 * an attacker attaching *their* provider account to *someone else's* client. It
 * therefore has to do four jobs, and this module is where each is enforced:
 *
 *   unguessable   128 bits from a CSPRNG, never a counter or a client id
 *   single-use    consumed on first use, so a replayed callback fails
 *   short-lived   minutes, not hours
 *   bound         to one client *and* one provider, so a state minted for
 *                 client A's Meta flow cannot be redeemed for client B's, or
 *                 for client A's Google flow
 *
 * Only a SHA-256 hash is stored. The raw state travels through the operator's
 * browser and the provider's servers, so treating it as a bearer secret in the
 * database would mean a read-only leak hands someone a working state. Hashing
 * costs nothing here because lookup is by exact value, never by prefix.
 */

import { createHash, randomBytes } from 'node:crypto';
import { Platform } from '@prisma/client';

import { prisma } from '../../lib/prisma.js';
import { decryptSecret, encryptSecret } from '../../lib/crypto.js';

/** How long an authorization attempt stays redeemable. */
export const STATE_TTL_MS = 10 * 60 * 1000;

export function hashState(state: string): string {
  return createHash('sha256').update(state, 'utf8').digest('hex');
}

/** RFC 7636 S256 challenge for providers that support PKCE. */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'utf8').digest('base64url');
}

export interface IssuedState {
  state: string;
  codeVerifier: string;
  codeChallenge: string;
  transactionId: string;
}

export async function issueState(input: {
  organizationId: string;
  clientId: string;
  platform: Platform;
  redirectUri: string;
  metadata?: Record<string, unknown>;
  now?: Date;
}): Promise<IssuedState> {
  const state = randomBytes(32).toString('base64url');
  const codeVerifier = randomBytes(48).toString('base64url');
  const now = input.now ?? new Date();

  const transaction = await prisma.oAuthTransaction.create({
    data: {
      organizationId: input.organizationId,
      clientId: input.clientId,
      platform: input.platform,
      stateHash: hashState(state),
      redirectUri: input.redirectUri,
      codeVerifierEnc: encryptSecret(codeVerifier),
      expiresAt: new Date(now.getTime() + STATE_TTL_MS),
      metadata: (input.metadata ?? {}) as object,
    },
    select: { id: true },
  });

  return { state, codeVerifier, codeChallenge: pkceChallenge(codeVerifier), transactionId: transaction.id };
}

export type StateRejection =
  | 'UNKNOWN_STATE'
  | 'EXPIRED'
  | 'ALREADY_USED'
  | 'CLIENT_MISMATCH'
  | 'PROVIDER_MISMATCH';

export class InvalidOAuthStateError extends Error {
  readonly reason: StateRejection;

  constructor(reason: StateRejection) {
    // The message is deliberately the same shape for every reason: an attacker
    // probing the callback must not learn whether a state existed, whether it
    // belonged to another client, or whether it had simply expired.
    super('The authorization request could not be verified. Start the connection again.');
    this.name = 'InvalidOAuthStateError';
    this.reason = reason;
  }
}

export interface ConsumedState {
  transactionId: string;
  organizationId: string;
  clientId: string;
  platform: Platform;
  redirectUri: string;
  codeVerifier: string | null;
  metadata: Record<string, unknown>;
}

/**
 * Validate and consume a state in one step.
 *
 * Consumption is a conditional update rather than a read followed by a write:
 * two callbacks arriving together would both pass a read-then-check, and the
 * second would be a successful replay. `updateMany` with `consumedAt: null` in
 * the filter means the database decides the winner, and the loser sees zero
 * rows updated.
 */
export async function consumeState(input: {
  state: string;
  platform: Platform;
  /** The client the caller believes this callback is for, when known. */
  expectedClientId?: string;
  now?: Date;
}): Promise<ConsumedState> {
  const now = input.now ?? new Date();
  const stateHash = hashState(input.state);

  const transaction = await prisma.oAuthTransaction.findUnique({ where: { stateHash } });
  if (!transaction) throw new InvalidOAuthStateError('UNKNOWN_STATE');

  // Checked before consuming, so a mismatched attempt cannot burn a state that
  // legitimately belongs to another flow.
  if (transaction.platform !== input.platform) throw new InvalidOAuthStateError('PROVIDER_MISMATCH');
  if (input.expectedClientId && transaction.clientId !== input.expectedClientId) {
    throw new InvalidOAuthStateError('CLIENT_MISMATCH');
  }
  if (transaction.consumedAt) throw new InvalidOAuthStateError('ALREADY_USED');
  if (transaction.expiresAt <= now) throw new InvalidOAuthStateError('EXPIRED');

  const claimed = await prisma.oAuthTransaction.updateMany({
    where: { id: transaction.id, consumedAt: null, expiresAt: { gt: now } },
    data: { consumedAt: now },
  });
  // Lost the race against a concurrent callback: that one consumed it first.
  if (claimed.count === 0) throw new InvalidOAuthStateError('ALREADY_USED');

  return {
    transactionId: transaction.id,
    organizationId: transaction.organizationId,
    clientId: transaction.clientId,
    platform: transaction.platform,
    redirectUri: transaction.redirectUri,
    codeVerifier: transaction.codeVerifierEnc ? decryptSecret(transaction.codeVerifierEnc) : null,
    metadata: (transaction.metadata ?? {}) as Record<string, unknown>,
  };
}

/**
 * Drop states that can no longer be redeemed.
 *
 * Expired rows are harmless but unbounded, and an OAuth table that only ever
 * grows is a slow leak of hashes nobody is watching.
 */
export async function pruneExpiredStates(now: Date = new Date()): Promise<number> {
  const { count } = await prisma.oAuthTransaction.deleteMany({
    where: { expiresAt: { lt: new Date(now.getTime() - STATE_TTL_MS) } },
  });
  return count;
}
