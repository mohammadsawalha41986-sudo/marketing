/**
 * Notification creation.
 *
 * There is one recipient — the operator — so this fans out to every active
 * account rather than resolving an audience from roles. The `restaurantId` is
 * carried so the notification can be filtered and linked back to the restaurant
 * it concerns.
 */

import { NotificationType } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

interface NotifyInput {
  restaurantId?: string | null;
  type: NotificationType;
  title: string;
  body?: string;
  link?: string;
}

export async function notify(input: NotifyInput): Promise<void> {
  const recipients = await prisma.user.findMany({ where: { isActive: true }, select: { id: true } });
  if (recipients.length === 0) return;

  await prisma.notification.createMany({
    data: recipients.map((user) => ({
      restaurantId: input.restaurantId ?? null,
      userId: user.id,
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      link: input.link ?? null,
    })),
  });
}

export { NotificationType };
