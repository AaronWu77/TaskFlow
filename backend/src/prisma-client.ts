import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var taskFlowPrisma: PrismaClient | undefined;
}

export const prisma = globalThis.taskFlowPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalThis.taskFlowPrisma = prisma;
}
