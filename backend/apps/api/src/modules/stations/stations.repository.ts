import type { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../database/prisma.js';
import { HttpError } from '../../types/http-error.js';
import {
  orderStatus,
  activePumpOrderStatuses,
} from '../orders/orders.types.js';
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
  pumpLookup(where: Prisma.StationWhereInput, tx: Prisma.TransactionClient) {
    return tx.station.findFirst({
      where,
      select: {
        id: true,
        isActive: true,
        pumps: {
          orderBy: [{ number: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            number: true,
            status: true,
            _count: {
              select: {
                orders: { where: { status: { in: activePumpOrderStatuses } } },
              },
            },
          },
        },
      },
    });
  },
  async lockManager(id: number, tx: Prisma.TransactionClient) {
    // Same user-row lock as role/status changes. Always acquire before station.
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${id} FOR UPDATE`;
  },
  assignmentUser(id: number, tx: Prisma.TransactionClient) {
    return tx.user.findUnique({
      where: { id },
      select: {
        id: true,
        isActive: true,
        role: {
          select: {
            name: true,
            permissions: { select: { permission: { select: { key: true } } } },
          },
        },
      },
    });
  },
  ownedStation(managerId: number, tx: Prisma.TransactionClient) {
    return tx.station.findFirst({ where: { managerId }, select: { id: true } });
  },
  async lockStation(id: number, tx: Prisma.TransactionClient) {
    // Status changes lock only the station, never employees or orders. This
    // avoids reversing the employee -> station lock order of fulfillment.
    await tx.$queryRaw`SELECT id FROM stations WHERE id = ${id} FOR UPDATE`;
  },
  async hasBlockingOrder(stationId: number, tx: Prisma.TransactionClient) {
    return (
      (await tx.fuelOrder.findFirst({
        where: {
          stationId,
          OR: [
            { status: orderStatus.IN_PROGRESS },
            {
              status: orderStatus.PENDING,
              payments: {
                some: { status: 'CONFIRMED', capturedMinor: { gt: 0 } },
              },
            },
          ],
        },
        select: { id: true },
      })) !== null
    );
  },
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
          // The pg adapter wraps raw FOR UPDATE serialization failures in P2010.
          const meta = (
            error as {
              meta?: {
                code?: string;
                driverAdapterError?: { cause?: { originalCode?: string } };
              };
            }
          ).meta;
          const rawSerializationFailure =
            error.code === 'P2010' &&
            (meta?.code === '40001' ||
              meta?.driverAdapterError?.cause?.originalCode === '40001');
          if (error.code === 'P2034' || rawSerializationFailure) {
            if (attempt < 2) continue;
            throw new HttpError('Concurrent update; retry request', 409);
          }
          if (error.code === 'P2025')
            throw new HttpError('Station not found', 404);
          if (error.code === 'P2002')
            throw new HttpError('Manager already owns another station', 409);
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
    data:
      UpdateStationInput | { isActive: boolean } | { managerId: number | null },
    tx: Prisma.TransactionClient,
  ) {
    return tx.station.update({ where: { id }, data, select: stationSelect });
  },
};
