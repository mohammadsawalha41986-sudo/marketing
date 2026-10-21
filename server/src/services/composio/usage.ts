/**
 * Consumption & cost, for the agency running many restaurants.
 *
 * Every figure is a count of something this database recorded. The estimated
 * provider cost is the one derived figure, and it is computed only from prices
 * an operator has entered (COMPOSIO_PLAN_MONTHLY_USD, COMPOSIO_INCLUDED_CALLS,
 * COMPOSIO_OVERAGE_PER_1K_USD). Composio's pricing page could not be read when
 * this was written, and an invented price is worse than none: with any of the
 * three unset the estimate is null and the reason says which.
 *
 * Calls are metered for Composio only. Direct calls to Meta, TikTok and Google
 * cost nothing per call but count against those platforms' rate limits; they
 * are not in `calls` and the response says so rather than implying a total.
 */

import { IntegrationStatus, SyncStatus, type PrismaClient } from '@prisma/client';

function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function estimateCost(calls: number, env: NodeJS.ProcessEnv = process.env): {
  estimatedUsd: number | null;
  reason: string | null;
} {
  const plan = Number(env.COMPOSIO_PLAN_MONTHLY_USD);
  const included = Number(env.COMPOSIO_INCLUDED_CALLS);
  const overage = Number(env.COMPOSIO_OVERAGE_PER_1K_USD);
  const missing = [
    !env.COMPOSIO_PLAN_MONTHLY_USD || Number.isNaN(plan) ? 'COMPOSIO_PLAN_MONTHLY_USD' : null,
    !env.COMPOSIO_INCLUDED_CALLS || Number.isNaN(included) ? 'COMPOSIO_INCLUDED_CALLS' : null,
    !env.COMPOSIO_OVERAGE_PER_1K_USD || Number.isNaN(overage) ? 'COMPOSIO_OVERAGE_PER_1K_USD' : null,
  ].filter((entry): entry is string => Boolean(entry));
  if (missing.length > 0) {
    return {
      estimatedUsd: null,
      reason: `No estimate: set ${missing.join(', ')} from your Composio plan (composio.dev/pricing). Prices are not assumed.`,
    };
  }
  const extra = Math.max(0, calls - included);
  return { estimatedUsd: Math.round((plan + (extra / 1000) * overage) * 100) / 100, reason: null };
}

export async function usageSummary(input: { prisma: PrismaClient; organizationId: string; now?: Date }) {
  const now = input.now ?? new Date();
  const since = monthStart(now);
  const org = input.organizationId;

  const [clients, direct, composio, calls, failedCalls, byOperation, syncRuns, failedSyncs] = await Promise.all([
    input.prisma.client.findMany({
      where: { organizationId: org, status: { not: 'ARCHIVED' } },
      select: { id: true, businessName: true },
      orderBy: { businessName: 'asc' },
    }),
    input.prisma.integration.groupBy({
      by: ['clientId'],
      where: { organizationId: org, status: IntegrationStatus.CONNECTED },
      _count: { _all: true },
    }),
    input.prisma.composioConnection.groupBy({
      by: ['clientId', 'remoteStatus'],
      where: { organizationId: org },
      _count: { _all: true },
    }),
    input.prisma.providerCallLog.count({ where: { organizationId: org, createdAt: { gte: since } } }),
    input.prisma.providerCallLog.count({ where: { organizationId: org, createdAt: { gte: since }, success: false } }),
    input.prisma.providerCallLog.groupBy({
      by: ['operation'],
      where: { organizationId: org, createdAt: { gte: since } },
      _count: { _all: true },
    }),
    input.prisma.integrationSyncRun.count({ where: { organizationId: org, startedAt: { gte: since } } }),
    input.prisma.integrationSyncRun.count({ where: { organizationId: org, startedAt: { gte: since }, status: SyncStatus.FAILED } }),
  ]);

  const perRestaurant = clients.map((client) => {
    const directCount = direct.find((row) => row.clientId === client.id)?._count._all ?? 0;
    const composioRows = composio.filter((row) => row.clientId === client.id);
    return {
      clientId: client.id,
      name: client.businessName,
      direct: directCount,
      composio: composioRows.reduce((sum, row) => sum + row._count._all, 0),
      composioActive: composioRows.filter((row) => row.remoteStatus === 'ACTIVE').reduce((sum, row) => sum + row._count._all, 0),
    };
  });

  const totalConnections = perRestaurant.reduce((sum, row) => sum + row.direct + row.composio, 0);
  const composioSyncs = byOperation.find((row) => row.operation === 'connected_accounts.list')?._count._all ?? 0;

  return {
    period: { from: since.toISOString(), to: now.toISOString() },
    totalRestaurants: clients.length,
    totalConnections,
    connectionsPerRestaurant: clients.length > 0 ? Math.round((totalConnections / clients.length) * 10) / 10 : 0,
    perRestaurant,
    calls: {
      provider: 'COMPOSIO',
      thisMonth: calls,
      failed: failedCalls,
      byOperation: byOperation.map((row) => ({ operation: row.operation, count: row._count._all })),
      note: 'Composio calls only. Direct Meta, TikTok and Google calls are not metered here.',
    },
    syncOperations: { thisMonth: syncRuns + composioSyncs, failed: failedSyncs },
    cost: estimateCost(calls),
  };
}
