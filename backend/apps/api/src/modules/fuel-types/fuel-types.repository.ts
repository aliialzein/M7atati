import { prisma } from '../../database/prisma.js';

export const fuelTypesRepository = {
  list() {
    return prisma.fuelType.findMany({
      select: { id: true, name: true, code: true },
      orderBy: [{ code: 'asc' }, { id: 'asc' }],
    });
  },
};
