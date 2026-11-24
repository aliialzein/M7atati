import type { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../database/prisma.js';
import { attendanceWhere } from '../attendance/attendance.query.js';
import type { StationAnalyticsInput } from './analytics.validation.js';
import { ordersWhere } from '../orders/orders.repository.js';

export const analyticsRepository = {
  orders(
    stationId: number,
    input: StationAnalyticsInput,
    tx: Prisma.TransactionClient,
  ) {
    return tx.fuelOrder.groupBy({
      by: ['status'],
      where: ordersWhere(stationId, input),
      _count: { _all: true },
    });
  },
  transaction<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return prisma.$transaction(work, { isolationLevel: 'RepeatableRead' });
  },
  async attendance(
    stationId: number,
    input: StationAnalyticsInput,
    tx: Prisma.TransactionClient,
  ) {
    const where = attendanceWhere({ ...input, stationId });
    const [totalRecords, openRecords] = await Promise.all([
      tx.attendanceRecord.count({ where }),
      tx.attendanceRecord.count({
        where: { AND: [where, { clockOutAt: null }] },
      }),
    ]);
    return {
      totalRecords,
      openRecords,
      closedRecords: totalRecords - openRecords,
    };
  },
};
