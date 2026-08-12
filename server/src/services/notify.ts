/** Notification creation. One place so every event reads consistently. */

import { NotificationType, Role } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

interface NotifyInput {
  organizationId: string;
  clientId?: string | null;
  type: NotificationType;
  title: string;
  body?: string;
  link?: string;
  /** Who should see it. Defaults to everyone on the agency side of the tenant. */
  audience?: 'agency' | 'client' | 'both';
}

export async function notify(input: NotifyInput): Promise<void> {
  const audience = input.audience ?? 'agency';
  const roles: Role[] = [];
  if (audience === 'agency' || audience === 'both') {
    roles.push(Role.SUPER_ADMIN, Role.AGENCY_ADMIN, Role.AGENCY_STAFF);
  }
  if (audience === 'client' || audience === 'both') {
    roles.push(Role.CLIENT_ADMIN, Role.CLIENT_USER);
  }

  const recipients = await prisma.user.findMany({
    where: {
      organizationId: input.organizationId,
      isActive: true,
      role: { in: roles },
      // Client-side recipients only get notifications about their own client.
      ...(input.clientId && audience !== 'agency'
        ? { OR: [{ clientId: input.clientId }, { clientId: null, role: { in: [Role.SUPER_ADMIN, Role.AGENCY_ADMIN, Role.AGENCY_STAFF] } }] }
        : {}),
    },
    select: { id: true },
  });

  if (recipients.length === 0) return;

  await prisma.notification.createMany({
    data: recipients.map((user) => ({
      organizationId: input.organizationId,
      clientId: input.clientId ?? null,
      userId: user.id,
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      link: input.link ?? null,
    })),
  });
}

export { NotificationType };
