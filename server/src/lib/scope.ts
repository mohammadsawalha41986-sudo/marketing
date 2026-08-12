/**
 * Tenant scoping. This is the single place that decides which rows an actor may
 * touch, and it is derived only from the authenticated session — never from a
 * body field, query parameter or header.
 *
 * Rules:
 *   - Agency roles see everything inside their own organization.
 *   - Client roles see only rows carrying their own `clientId`.
 *   - SUPER_ADMIN is scoped like an agency admin on the normal API. Cross-tenant
 *     reach is granted only by `crossTenant()`, which the /api/admin router uses.
 */

import { Role } from '@prisma/client';
import { forbidden, notFound } from './errors.js';

export interface Actor {
  id: string;
  email: string;
  name: string;
  role: Role;
  organizationId: string | null;
  clientId: string | null;
}

export const AGENCY_ROLES: Role[] = [Role.SUPER_ADMIN, Role.AGENCY_ADMIN, Role.AGENCY_STAFF];
export const CLIENT_ROLES: Role[] = [Role.CLIENT_ADMIN, Role.CLIENT_USER];

export const isAgency = (actor: Actor) => AGENCY_ROLES.includes(actor.role);
export const isClientUser = (actor: Actor) => CLIENT_ROLES.includes(actor.role);
export const canManage = (actor: Actor) =>
  actor.role === Role.SUPER_ADMIN || actor.role === Role.AGENCY_ADMIN;

/** The organization every query must be pinned to. */
export function orgId(actor: Actor): string {
  if (!actor.organizationId) throw forbidden('Your account is not attached to an organization');
  return actor.organizationId;
}

/**
 * Base `where` for any tenant-owned model that has `organizationId`, plus
 * `clientId` when the model has one and the actor is a client user.
 */
export function scopeWhere(actor: Actor): { organizationId: string; clientId?: string } {
  const base = { organizationId: orgId(actor) };
  if (isClientUser(actor)) {
    if (!actor.clientId) throw forbidden('Your account is not attached to a client');
    return { ...base, clientId: actor.clientId };
  }
  return base;
}

/** Same, for models keyed only by client (no organizationId column). */
export function clientScopeWhere(actor: Actor): { clientId?: string } {
  if (isClientUser(actor)) {
    if (!actor.clientId) throw forbidden('Your account is not attached to a client');
    return { clientId: actor.clientId };
  }
  return {};
}

/**
 * Validate a client id supplied by the caller against what they may reach.
 * A client user may only ever name their own client; passing another id is
 * treated as a miss, not as a permission error, so the API does not confirm
 * that the other client exists.
 */
export function assertClientAccess(actor: Actor, clientId: string): string {
  if (isClientUser(actor)) {
    if (actor.clientId !== clientId) throw notFound('Client');
    return clientId;
  }
  return clientId;
}

/** Resolve the client a request targets: the actor's own for client users. */
export function resolveClientId(actor: Actor, requested?: string | null): string | undefined {
  if (isClientUser(actor)) {
    if (!actor.clientId) throw forbidden('Your account is not attached to a client');
    if (requested && requested !== actor.clientId) throw notFound('Client');
    return actor.clientId;
  }
  return requested ?? undefined;
}

/** Only for /api/admin: lets SUPER_ADMIN read across organizations. */
export function crossTenant(actor: Actor): void {
  if (actor.role !== Role.SUPER_ADMIN) throw forbidden('Super admin only');
}

/** Throws unless the actor may create/update/delete within the tenant. */
export function assertWritable(actor: Actor): void {
  if (isClientUser(actor)) throw forbidden('Client accounts have read and approval access only');
}
