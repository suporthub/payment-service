import { PrismaClient } from '@prisma/client';
import { logger } from './logger';

const prismaRead  = new PrismaClient({ log: [{ emit: 'event', level: 'error' }] });
const prismaWrite = new PrismaClient({ log: [{ emit: 'event', level: 'error' }] });

// Log Prisma errors via pino
prismaRead.$on('error',  (e) => logger.error({ err: e }, 'Prisma read error'));
prismaWrite.$on('error', (e) => logger.error({ err: e }, 'Prisma write error'));

export { prismaRead, prismaWrite };

export async function connectDB(): Promise<void> {
  await prismaWrite.$connect();
  await prismaRead.$connect();
}

export async function disconnectDB(): Promise<void> {
  await prismaWrite.$disconnect();
  await prismaRead.$disconnect();
}
