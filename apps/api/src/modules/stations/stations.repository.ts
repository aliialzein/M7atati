import type { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../database/prisma.js';
import { HttpError } from '../../types/http-error.js';
import { pickerSelect, stationSelect } from './stations.types.js';
import type {
  CreateStationInput,
  ListStationsInput,
  UpdateStationInput,
} from './stations.validation.js';

const orderBy = [
  { name: 'asc' },
  { id: 'asc' },
] satisfies Prisma.StationOrderByWithRelationInput[];

export const stationsRepository = {
  managed(where: Prisma.StationWhereInput) {
    return prisma.station.findMany({
      where,
      select: { id: true, name: true, isActive: true },
      orderBy,
    });
  },
  async transaction<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await prisma.$transaction(work, {
          isolationLevel: 'Serializable',
        });
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error) {
          if (error.code === 'P2034') {
            if (attempt < 2) continue;
            throw new HttpError('Concurrent update; retry request', 409);
          }
          if (error.code === 'P2025')
            throw new HttpError('Station not found', 404);
        }
        throw error;
      }
    }
  },
  async list(
    where: Prisma.StationWhereInput,
    input: ListStationsInput,
    tx: Prisma.TransactionClient,
  ) {
    const [stations, total] = await Promise.all([
      tx.station.findMany({
        where,
        select: stationSelect,
        orderBy,
        skip: (input.page - 1) * input.limit,
        take: input.limit,
      }),
      tx.station.count({ where }),
    ]);
    return { stations, total };
  },
  picker() {
    return prisma.station.findMany({
      where: { isActive: true },
      select: pickerSelect,
      orderBy,
    });
  },
  find(id: number, tx: Prisma.TransactionClient) {
    return tx.station.findUnique({ where: { id }, select: stationSelect });
  },
  create(input: CreateStationInput) {
    return prisma.station.create({
      data: {
        name: input.name,
        address: input.address,
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
      },
      select: stationSelect,
    });
  },
  update(
    id: number,
    data: UpdateStationInput | { isActive: boolean },
    tx: Prisma.TransactionClient,
  ) {
    return tx.station.update({ where: { id }, data, select: stationSelect });
  },
};
