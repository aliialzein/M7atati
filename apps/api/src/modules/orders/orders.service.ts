import type { Prisma } from '../../generated/prisma/client.js';
import type { UserProfile } from '../auth/auth.types.js';
import { HttpError } from '../../types/http-error.js';
import {
  employeeOrdersRepository,
  managerOrdersRepository,
} from './orders.repository.js';
import { demoOrdersForStation, selectDemoOrders } from './orders.demo.js';
import type {
  ListOrdersInput,
  EmployeeOrdersInput,
  EmployeeWorkInput,
} from './orders.validation.js';

export const ordersService = {
  async list(actor: UserProfile, stationId: number, input: ListOrdersInput) {
    // Authorize before consulting demo data, including empty selections. This is
    // the only resource DB operation; the demo data never touches FuelOrder.
    await managerOrdersRepository.managedStation(actor, stationId);
    const selected = selectDemoOrders(
      demoOrdersForStation(stationId),
      stationId,
      input,
    );
    const total = selected.length;
    const skip = (input.page - 1) * input.limit;
    return {
      dataSource: 'demo' as const,
      orders: selected.slice(skip, skip + input.limit),
      pagination: {
        page: input.page,
        limit: input.limit,
        total,
        totalPages: Math.ceil(total / input.limit),
      },
    };
  },
};

async function assignedEmployee(
  actor: UserProfile,
  tx: Prisma.TransactionClient,
  write = false,
) {
  if (write) await employeeOrdersRepository.lockEmployee(actor.id, tx);
  const employee = await employeeOrdersRepository.employee(actor.id, tx);
  if (!employee?.isActive) throw new HttpError('Unauthenticated', 401);
  if (
    employee.role.name !== 'EMPLOYEE' ||
    (write &&
      !employee.role.permissions.some(
        ({ permission }) => permission.key === 'orders.update',
      ))
  )
    throw new HttpError('Insufficient permissions', 403);
  if (employee.stationId === null || !employee.station)
    throw new HttpError(
      'An assigned station is required to view pending orders',
      409,
    );
  if (!employee.station.isActive)
    throw new HttpError('Assigned station is inactive', 409);
  return { ...employee, stationId: employee.stationId };
}

function pagination(input: { page: number; limit: number }, total: number) {
  return { ...input, total, totalPages: Math.ceil(total / input.limit) };
}

export const employeeOrdersService = {
  mine(actor: UserProfile, input: EmployeeWorkInput) {
    return employeeOrdersRepository.transaction(async (tx) => {
      const employee = await assignedEmployee(actor, tx);
      const { orders, total } = await employeeOrdersRepository.mine(
        employee.id,
        employee.stationId,
        input,
        tx,
      );
      return {
        dataSource: 'database' as const,
        stationId: employee.stationId,
        orders,
        pagination: pagination({ page: input.page, limit: input.limit }, total),
      };
    });
  },
  detail(actor: UserProfile, id: number) {
    return employeeOrdersRepository.transaction(async (tx) => {
      const employee = await assignedEmployee(actor, tx);
      const order = await employeeOrdersRepository.detail(
        id,
        employee.stationId,
        tx,
      );
      if (!order) throw new HttpError('Order not found', 404);
      return {
        dataSource: 'database' as const,
        stationId: employee.stationId,
        order,
      };
    });
  },
  transition(actor: UserProfile, id: number, action: 'claim' | 'complete') {
    return employeeOrdersRepository.writeTransaction(async (tx) => {
      const employee = await assignedEmployee(actor, tx, true);
      const order = await employeeOrdersRepository.detail(
        id,
        employee.stationId,
        tx,
      );
      if (!order) throw new HttpError('Order not found', 404);
      const own = order.assignedEmployeeId === employee.id;
      // Resolve retries only after current authorization. A delayed claim retry
      // after completion acknowledges that original claim without moving backward.
      if (
        own &&
        (order.status === 'COMPLETED' ||
          (action === 'claim' && order.status === 'IN_PROGRESS'))
      )
        return {
          dataSource: 'database' as const,
          stationId: employee.stationId,
          order,
        };
      if (
        action === 'claim'
          ? order.status !== 'PENDING' || order.assignedEmployeeId !== null
          : order.status !== 'IN_PROGRESS' || !own
      )
        throw new HttpError(
          'Order is no longer available or its status changed',
          409,
        );
      const changed = await employeeOrdersRepository[action](
        id,
        employee.stationId,
        employee.id,
        tx,
      );
      if (changed.count !== 1)
        throw new HttpError(
          'Order is no longer available or its status changed',
          409,
        );
      await employeeOrdersRepository.event(
        id,
        employee.id,
        action === 'claim' ? 'PENDING' : 'IN_PROGRESS',
        action === 'claim' ? 'IN_PROGRESS' : 'COMPLETED',
        tx,
      );
      return {
        dataSource: 'database' as const,
        stationId: employee.stationId,
        order: await employeeOrdersRepository.detail(
          id,
          employee.stationId,
          tx,
        ),
      };
    });
  },
  list(actor: UserProfile, input: EmployeeOrdersInput) {
    return employeeOrdersRepository.transaction(async (tx) => {
      // Assignment comes from this snapshot, never the client or a cached profile.
      const employee = await employeeOrdersRepository.employee(actor.id, tx);
      if (!employee?.isActive) throw new HttpError('Unauthenticated', 401);
      if (employee.role.name !== 'EMPLOYEE')
        throw new HttpError('Insufficient permissions', 403);
      if (employee.stationId === null || !employee.station)
        throw new HttpError(
          'An assigned station is required to view pending orders',
          409,
        );
      if (!employee.station.isActive)
        throw new HttpError('Assigned station is inactive', 409);
      const { orders, total } = await employeeOrdersRepository.pending(
        employee.stationId,
        input,
        tx,
      );
      return {
        dataSource: 'database' as const,
        stationId: employee.stationId,
        orders,
        pagination: {
          page: input.page,
          limit: input.limit,
          total,
          totalPages: Math.ceil(total / input.limit),
        },
      };
    });
  },
};
