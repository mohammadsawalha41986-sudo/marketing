/** Append-only activity log. Never throws into the request path. */

import { prisma } from '../lib/prisma.js';
import type { Actor } from '../lib/actor.js';

export async function recordAudit(input: {
  actor?: Actor | null;
  action: string;
  entity: string;
  entityId?: string | null;
  meta?: Record<string, unknown>;
  ip?: string;
}): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: input.actor?.id ?? null,
        action: input.action,
        entity: input.entity,
        entityId: input.entityId ?? null,
        meta: (input.meta ?? {}) as object,
        ip: input.ip?.slice(0, 100) ?? null,
      },
    });
  } catch (error) {
    // Losing an audit row must never fail the operation that produced it.
    console.error('[audit] failed to write entry:', (error as Error).message);
  }
}

export async function recordAiUsage(input: {
  restaurantId?: string | null;
  kind: 'CONTENT' | 'HASHTAGS' | 'ANALYSIS' | 'BRAND';
  model: string;
  provider: string;
  latencyMs: number;
  success?: boolean;
}): Promise<void> {
  try {
    await prisma.aiUsage.create({
      data: {
        restaurantId: input.restaurantId ?? null,
        kind: input.kind,
        model: input.model,
        provider: input.provider,
        latencyMs: input.latencyMs,
        success: input.success ?? true,
      },
    });
  } catch (error) {
    console.error('[ai-usage] failed to write entry:', (error as Error).message);
  }
}
