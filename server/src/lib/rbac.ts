/**
 * What each role may do, as one table.
 *
 * Two axes, kept apart on purpose. `Role` says which side of the tenancy a user
 * is on — the agency that runs the platform, or a restaurant — and `scope.ts`
 * enforces *where* they may act (their organisation; their one restaurant).
 * `ClientRole` says what a restaurant-side user does inside their restaurant.
 * This module answers only *what*: a permission check never widens the scope a
 * user already has, it only narrows what they can do within it.
 *
 * Super Admin manages this platform. Nothing here lets anyone act on a
 * platform account they have not been authorised for by its owner — that
 * authorisation lives with Meta, TikTok and Google, not in this table.
 */

import { ClientRole, Role } from '@prisma/client';

import { forbidden } from './errors.js';
import type { Actor } from './scope.js';

export const PERMISSIONS = [
  'integrations.view',
  'integrations.manage',
  'content.create',
  'content.approve',
  'content.publish',
  'campaigns.view',
  'campaigns.manage',
  'budgets.manage',
  'analytics.view',
  'finance.view',
  'team.manage',
  'usage.view',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL = new Set<Permission>(PERMISSIONS);

const CLIENT_MATRIX: Record<ClientRole, Set<Permission>> = {
  [ClientRole.OWNER]: new Set<Permission>([
    'integrations.view', 'integrations.manage', 'content.create', 'content.approve', 'content.publish',
    'campaigns.view', 'campaigns.manage', 'budgets.manage', 'analytics.view', 'finance.view', 'team.manage',
  ]),
  [ClientRole.MANAGER]: new Set<Permission>([
    'integrations.view', 'integrations.manage', 'content.create', 'content.approve', 'content.publish',
    'campaigns.view', 'campaigns.manage', 'analytics.view', 'finance.view',
  ]),
  [ClientRole.MARKETING_MANAGER]: new Set<Permission>([
    'integrations.view', 'content.create', 'content.approve', 'campaigns.view', 'campaigns.manage', 'analytics.view',
  ]),
  [ClientRole.CONTENT_CREATOR]: new Set<Permission>(['integrations.view', 'content.create', 'campaigns.view']),
  [ClientRole.FINANCIAL_ANALYST]: new Set<Permission>(['campaigns.view', 'analytics.view', 'finance.view']),
  [ClientRole.VIEWER]: new Set<Permission>(['integrations.view', 'campaigns.view', 'analytics.view']),
};

const AGENCY_MATRIX: Partial<Record<Role, Set<Permission>>> = {
  [Role.SUPER_ADMIN]: ALL,
  [Role.AGENCY_ADMIN]: ALL,
  // Agency staff run a restaurant's marketing day to day; money, people and
  // platform-wide consumption stay with the agency's administrators.
  [Role.AGENCY_STAFF]: new Set<Permission>([
    'integrations.view', 'integrations.manage', 'content.create', 'content.approve', 'content.publish',
    'campaigns.view', 'campaigns.manage', 'analytics.view',
  ]),
};

/** The restaurant role a client user acts as, filling in the default for old rows. */
export function effectiveClientRole(actor: Pick<Actor, 'role' | 'clientRole'>): ClientRole | null {
  if (actor.role === Role.CLIENT_ADMIN) return actor.clientRole ?? ClientRole.OWNER;
  if (actor.role === Role.CLIENT_USER) {
    // A CLIENT_USER may hold any restaurant role except OWNER, which is what
    // CLIENT_ADMIN is; an OWNER value on one is treated as MANAGER.
    const role = actor.clientRole ?? ClientRole.VIEWER;
    return role === ClientRole.OWNER ? ClientRole.MANAGER : role;
  }
  return null;
}

export function can(actor: Pick<Actor, 'role' | 'clientRole'>, permission: Permission): boolean {
  const clientRole = effectiveClientRole(actor);
  if (clientRole) return CLIENT_MATRIX[clientRole].has(permission);
  return AGENCY_MATRIX[actor.role]?.has(permission) ?? false;
}

export function assertCan(actor: Pick<Actor, 'role' | 'clientRole'>, permission: Permission): void {
  if (!can(actor, permission)) throw forbidden(`Your role does not allow ${permission}`);
}

/** Everything the actor may do — sent to the browser so it hides what it cannot. */
export function permissionsOf(actor: Pick<Actor, 'role' | 'clientRole'>): Permission[] {
  return PERMISSIONS.filter((permission) => can(actor, permission));
}
