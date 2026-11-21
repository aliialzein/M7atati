import type { UserProfile } from '../auth/auth.types.js';
import { requireManagedStation } from '../../utils/accessScope.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../database/prisma.js';
import { HttpError } from '../../types/http-error.js';
import type {
  EmployeeOrdersInput,
  EmployeeWorkInput,
} from './orders.validation.js';

export const queueOrderSelect = {
  id: true,
  status: true,
  createdAt: true,
  orderedVolume: true,
  pump: { select: { id: true, number: true } },
  fuelType: { select: { id: true, name: true, code: true } },
} satisfies Prisma.FuelOrderSelect;

export const workOrderSelect = {
  ...queueOrderSelect,
  stationId: true,
  assignedEmployeeId: true,
  claimedAt: true,
  updatedAt: true,
} satisfies Prisma.FuelOrderSelect;

export const detailOrderSelect = {
  ...workOrderSelect,
  events: {
    select: {
      id: true,
      actorUserId: true,
      actorType: true,
      fromStatus: true,
      toStatus: true,
      createdAt: true,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  },
} satisfies Prisma.FuelOrderSelect;

export const employeeOrdersRepository = {
  async writeTransaction<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await prisma.$transaction(work, {
          isolationLevel: 'Serializable',
        });
      } catch (error) {
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? error.code
            : undefined;
        if (code === 'P2034') {
          if (attempt < 2) continue;
          throw new HttpError('Concurrent update; retry request', 409);
        }
        if (code === 'P2003' || code === 'P2025')
          throw new HttpError('Related record changed; retry request', 409);
        throw error;
      }
    }
  },
  async lockEmployee(id: number, tx: Prisma.TransactionClient) {
    // Transfers update this same row. Lock before reading assignment so writes
    // cannot commit against an assignment concurrently replaced by a transfer.
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${id} FOR UPDATE`;
  },
  transaction<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return prisma.$transaction(work, { isolationLevel: 'RepeatableRead' });
  },
  employee(id: number, tx: Prisma.TransactionClient) {
    return tx.user.findUnique({
      where: { id },
      select: {
        id: true,
        isActive: true,
        stationId: true,
        role: {
          select: {
            name: true,
            permissions: { select: { permission: { select: { key: true } } } },
          },
        },
        station: { select: { id: true, isActive: true } },
      },
    });
  },
  async mine(
    employeeId: number,
    stationId: number,
    input: EmployeeWorkInput,
    tx: Prisma.TransactionClient,
  ) {
    const where = {
      stationId,
      assignedEmployeeId: employeeId,
      status: 'IN_PROGRESS',
    };
    const [orders, total] = await Promise.all([
      tx.fuelOrder.findMany({
        where,
        select: workOrderSelect,
        skip: (input.page - 1) * input.limit,
        take: input.limit,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      tx.fuelOrder.count({ where }),
    ]);
    return { orders, total };
  },
  detail(id: number, stationId: number, tx: Prisma.TransactionClient) {
    return tx.fuelOrder.findFirst({
      where: { id, stationId },
      select: detailOrderSelect,
    });
  },
  claim(
    id: number,
    stationId: number,
    employeeId: number,
    tx: Prisma.TransactionClient,
  ) {
    return tx.fuelOrder.updateMany({
      where: { id, stationId, status: 'PENDING', assignedEmployeeId: null },
      data: {
        assignedEmployeeId: employeeId,
        claimedAt: new Date(),
        status: 'IN_PROGRESS',
      },
    });
  },
  complete(
    id: number,
    stationId: number,
    employeeId: number,
    tx: Prisma.TransactionClient,
  ) {
    return tx.fuelOrder.updateMany({
      where: {
        id,
        stationId,
        status: 'IN_PROGRESS',
        assignedEmployeeId: employeeId,
      },
      data: { status: 'COMPLETED' },
    });
  },
  event(
    id: number,
    employeeId: number,
    fromStatus: string,
    toStatus: string,
    tx: Prisma.TransactionClient,
  ) {
    return tx.orderEvent.create({
      data: {
        orderId: id,
        actorUserId: employeeId,
        actorType: 'EMPLOYEE',
        fromStatus,
        toStatus,
      },
    });
  },
  async pending(
    stationId: number,
    input: EmployeeOrdersInput,
    tx: Prisma.TransactionClient,
  ) {
    const where = { stationId, status: input.status };
    const [orders, total] = await Promise.all([
      tx.fuelOrder.findMany({
        where,
        select: queueOrderSelect,
        skip: (input.page - 1) * input.limit,
        take: input.limit,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      tx.fuelOrder.count({ where }),
    ]);
    return { orders, total };
  },
};

// Manager demo reads only verify ownership in PostgreSQL; demo rows stay in orders.demo.ts.
export const managerOrdersRepository = {
  managedStation(actor: UserProfile, stationId: number) {
    return requireManagedStation(actor, stationId, prisma);
  },
};
