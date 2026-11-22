import type { UserProfile } from '../auth/auth.types.js';
import { requireManagedStation } from '../../utils/accessScope.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../database/prisma.js';
import { HttpError } from '../../types/http-error.js';
import {
  employeeOrderTransitions,
  orderStatus,
  type OrderStatus,
  type OrderFilters,
} from './orders.types.js';
import type {
  EmployeeOrdersInput,
  EmployeeWorkInput,
  ListOrdersInput,
  CustomerOrderHistoryInput,
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
  async lockStation(id: number, tx: Prisma.TransactionClient) {
    // Lock order: employee, station, order. Shared locks allow concurrent work
    // at one station while excluding station status changes until commit.
    const stations = await tx.$queryRaw<{ id: number; isActive: boolean }[]>`
      SELECT id, is_active AS "isActive" FROM stations WHERE id = ${id} FOR SHARE`;
    return stations[0] ?? null;
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
      status: orderStatus.IN_PROGRESS,
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
      where: {
        id,
        stationId,
        status: employeeOrderTransitions.claim.from,
        assignedEmployeeId: null,
      },
      data: {
        assignedEmployeeId: employeeId,
        claimedAt: new Date(),
        status: employeeOrderTransitions.claim.to,
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
        status: employeeOrderTransitions.complete.from,
        assignedEmployeeId: employeeId,
      },
      data: { status: employeeOrderTransitions.complete.to },
    });
  },
  event(
    id: number,
    employeeId: number,
    fromStatus: OrderStatus,
    toStatus: OrderStatus,
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
    // Legacy assigned PENDING rows cannot be claimed; do not advertise them as work.
    const where = { stationId, status: input.status, assignedEmployeeId: null };
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

// Shared by Manager listing and analytics so date bounds have identical semantics.
export function ordersWhere(
  stationId: number,
  input: OrderFilters,
): Prisma.FuelOrderWhereInput {
  return {
    stationId,
    ...(input.status ? { status: input.status } : {}),
    ...(input.from || input.to
      ? {
          createdAt: {
            ...(input.from ? { gte: input.from } : {}),
            ...(input.to ? { lt: input.to } : {}),
          },
        }
      : {}),
    ...(input.minAmountMinor !== undefined || input.maxAmountMinor !== undefined
      ? {
          orderedAmountMinor: {
            ...(input.minAmountMinor !== undefined
              ? { gte: input.minAmountMinor }
              : {}),
            ...(input.maxAmountMinor !== undefined
              ? { lte: input.maxAmountMinor }
              : {}),
          },
        }
      : {}),
  };
}

const managerOrderSelect = {
  ...workOrderSelect,
  source: true,
  currency: true,
  fulfillmentType: true,
  unitPriceMinor: true,
  orderedAmountMinor: true,
  dispensedVolume: true,
  finalMinor: true,
  scheduledFor: true,
  expiresAt: true,
  assignee: { select: { id: true, name: true, isActive: true } },
} satisfies Prisma.FuelOrderSelect;

export const managerOrdersRepository = {
  transaction<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return prisma.$transaction(work, { isolationLevel: 'RepeatableRead' });
  },
  managedStation(
    actor: UserProfile,
    stationId: number,
    tx: Prisma.TransactionClient,
  ) {
    return requireManagedStation(actor, stationId, tx);
  },
  async list(
    stationId: number,
    input: ListOrdersInput,
    tx: Prisma.TransactionClient,
  ) {
    const where = ordersWhere(stationId, input);
    const [orders, total] = await Promise.all([
      tx.fuelOrder.findMany({
        where,
        select: managerOrderSelect,
        skip: (input.page - 1) * input.limit,
        take: input.limit,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      tx.fuelOrder.count({ where }),
    ]);
    return { orders, total };
  },
  detail(id: number, stationId: number, tx: Prisma.TransactionClient) {
    return tx.fuelOrder.findFirst({
      where: { id, stationId },
      select: {
        ...managerOrderSelect,
        events: {
          ...detailOrderSelect.events,
          select: { ...detailOrderSelect.events.select, note: true },
        },
      },
    });
  },
};

export const createdOrderSelect = {
  id: true,
  quoteId: true,
  stationId: true,
  fuelTypeId: true,
  currency: true,
  fulfillmentType: true,
  source: true,
  status: true,
  pumpId: true,
  unitPriceMinor: true,
  orderedVolume: true,
  orderedAmountMinor: true,
  createdAt: true,
} satisfies Prisma.FuelOrderSelect;

export const orderCreationRepository = {
  async transaction<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    // A unique-key loser starts a fresh snapshot and resolves the original
    // result, instead of surfacing a database error or inserting another order.
    for (let attempt = 0; ; attempt++) {
      try {
        return await employeeOrdersRepository.writeTransaction(work);
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'P2002'
        ) {
          if (attempt < 2) continue;
          throw new HttpError('Order creation conflict; retry request', 409);
        }
        throw error;
      }
    }
  },
  async lockQuote(id: string, tx: Prisma.TransactionClient) {
    await tx.$queryRaw`SELECT id FROM order_quotes WHERE id = ${id}::uuid FOR UPDATE`;
  },
};

export const confirmedPaymentSelect = {
  id: true,
  orderId: true,
  method: true,
  currency: true,
  amountMinor: true,
  capturedMinor: true,
  status: true,
  confirmedById: true,
  confirmedAt: true,
} satisfies Prisma.PaymentSelect;

export const cashOrderSelect = {
  id: true,
  stationId: true,
  status: true,
  pumpId: true,
  currency: true,
  orderedAmountMinor: true,
  assignedEmployeeId: true,
  claimedAt: true,
  payments: { select: confirmedPaymentSelect },
} satisfies Prisma.FuelOrderSelect;

export const cashOrdersRepository = {
  async transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>) {
    try {
      return await employeeOrdersRepository.writeTransaction(work);
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'P2002'
      )
        throw new HttpError(
          'Payment confirmation conflict; retry request',
          409,
        );
      throw error;
    }
  },
  async lockStation(id: number, tx: Prisma.TransactionClient) {
    const rows = await tx.$queryRaw<
      {
        id: number;
        isActive: boolean;
        managerId: number | null;
      }[]
    >`SELECT id, is_active AS "isActive", manager_id AS "managerId"
         FROM stations WHERE id = ${id} FOR SHARE`;
    return rows[0] ?? null;
  },
  async lockOrder(id: number, stationId: number, tx: Prisma.TransactionClient) {
    await tx.$queryRaw`SELECT id FROM orders
      WHERE id = ${id} AND station_id = ${stationId} FOR UPDATE`;
    return tx.fuelOrder.findFirst({
      where: { id, stationId },
      select: cashOrderSelect,
    });
  },
  async lockPump(id: number, tx: Prisma.TransactionClient) {
    // Exclusive lock serializes availability checks for different orders. The
    // reservation itself is the active order, not a second pump status flag.
    const rows = await tx.$queryRaw<
      {
        id: number;
        stationId: number;
        status: string;
      }[]
    >`SELECT id, station_id AS "stationId", status
         FROM pumps WHERE id = ${id} FOR UPDATE`;
    return rows[0] ?? null;
  },
  activePumpOrder(pumpId: number, tx: Prisma.TransactionClient) {
    return tx.fuelOrder.findFirst({
      where: {
        pumpId,
        status: { in: [orderStatus.PENDING, orderStatus.IN_PROGRESS] },
      },
      select: { id: true },
    });
  },
};

// Explicit allowlists are shared by history and detail. Never spread a stored
// order or expose quote/payment/customer/staff records to a tracking response.
export const customerOrderSelect = {
  id: true,
  status: true,
  currency: true,
  fulfillmentType: true,
  orderedAmountMinor: true,
  orderedVolume: true,
  createdAt: true,
  updatedAt: true,
  claimedAt: true,
  scheduledFor: true,
  station: { select: { id: true, name: true, address: true } },
  fuelType: { select: { id: true, name: true, code: true } },
  pump: { select: { id: true, number: true } },
} satisfies Prisma.FuelOrderSelect;

export const customerOrderEventSelect = {
  id: true,
  fromStatus: true,
  toStatus: true,
  createdAt: true,
} satisfies Prisma.OrderEventSelect;

export const orderTrackingRepository = {
  transaction: employeeOrdersRepository.transaction,
  async mine(
    customerId: number,
    input: CustomerOrderHistoryInput,
    tx: Prisma.TransactionClient,
  ) {
    const where = {
      userId: customerId,
      ...(input.status ? { status: input.status } : {}),
    };
    const [orders, total] = await Promise.all([
      tx.fuelOrder.findMany({
        where,
        select: customerOrderSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (input.page - 1) * input.limit,
        take: input.limit,
      }),
      tx.fuelOrder.count({ where }),
    ]);
    return {
      orders,
      pagination: {
        page: input.page,
        limit: input.limit,
        total,
        totalPages: Math.ceil(total / input.limit),
      },
    };
  },
  customerOrder(id: number, userId: number, tx: Prisma.TransactionClient) {
    return tx.fuelOrder.findFirst({
      where: { id, userId },
      select: customerOrderSelect,
    });
  },
  guestOrder(id: number, tx: Prisma.TransactionClient) {
    return tx.fuelOrder.findFirst({
      where: { id, userId: null, source: 'GUEST' },
      select: {
        ...customerOrderSelect,
        quote: { select: { id: true, customerId: true, guestTokenHash: true } },
      },
    });
  },
  events(orderId: number, tx: Prisma.TransactionClient) {
    return tx.orderEvent.findMany({
      where: { orderId },
      select: customerOrderEventSelect,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  },
};

export const orderCancellationRepository = {
  async lockOrder(id: number, tx: Prisma.TransactionClient) {
    // Same order-row lock as cash confirmation. Cancellation never locks a
    // station or pump afterwards, so it cannot reverse their acquisition order.
    await tx.$queryRaw`SELECT id FROM orders WHERE id = ${id} FOR UPDATE`;
    return tx.fuelOrder.findFirst({
      where: { id },
      select: {
        status: true,
        pumpId: true,
        assignedEmployeeId: true,
        claimedAt: true,
        payments: { select: { id: true }, take: 1 },
      },
    });
  },
  cancel(id: number, tx: Prisma.TransactionClient) {
    return tx.fuelOrder.updateMany({
      where: {
        id,
        status: orderStatus.AWAITING_PAYMENT,
        pumpId: null,
        assignedEmployeeId: null,
        claimedAt: null,
        payments: { none: {} },
      },
      data: { status: orderStatus.CANCELLED },
    });
  },
  result(id: number, tx: Prisma.TransactionClient) {
    return tx.fuelOrder.findFirst({
      where: { id },
      select: customerOrderSelect,
    });
  },
};
