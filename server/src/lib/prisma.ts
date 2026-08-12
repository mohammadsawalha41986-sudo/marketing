import { PrismaClient } from '@prisma/client';
import { isProd } from '../env.js';

export const prisma = new PrismaClient({
  log: isProd ? ['error'] : ['error', 'warn'],
});

export type Tx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;
