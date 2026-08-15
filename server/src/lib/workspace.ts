/**
 * The workspace singleton.
 *
 * One operator, one workspace, so this is a single row pinned to a constant id
 * rather than a table that is queried by key. It holds what `Organization` used
 * to carry minus the tenancy: display name, currency, timezone and locale.
 */

import type { Workspace } from '@prisma/client';
import { prisma } from './prisma.js';

export const WORKSPACE_ID = 'workspace';

/**
 * Read the workspace, creating it on first call.
 *
 * `upsert` rather than a seeded row so a fresh database serves a working
 * application immediately after `migrate deploy`, with no seed step and no
 * request that fails because settings do not exist yet.
 */
export async function readWorkspace(): Promise<Workspace> {
  return prisma.workspace.upsert({
    where: { id: WORKSPACE_ID },
    create: { id: WORKSPACE_ID },
    update: {},
  });
}

/** Currency for money formatting and report headers. */
export async function workspaceCurrency(): Promise<string> {
  return (await readWorkspace()).currency;
}
