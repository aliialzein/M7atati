import type { UserProfile } from '../auth/auth.types.js';
import { requireReportingStation } from '../../utils/accessScope.js';
import { orderStatuses } from '../orders/orders.types.js';
import { analyticsRepository } from './analytics.repository.js';
import type { StationAnalyticsInput } from './analytics.validation.js';

export const analyticsService = {
  async station(
    actor: UserProfile,
    stationId: number,
    input: StationAnalyticsInput,
  ) {
    return analyticsRepository.transaction(async (tx) => {
      // Ownership, attendance and order counts use the same database snapshot.
      await requireReportingStation(actor, stationId, tx);
      const attendance = await analyticsRepository.attendance(
        stationId,
        input,
        tx,
      );
      const groups = await analyticsRepository.orders(stationId, input, tx);
      // Preserve any legacy string statuses in the counts rather than dropping
      // those orders. Known statuses always appear, including on empty stations.
      const countsByStatus: Record<string, number> = Object.fromEntries([
        ...orderStatuses.map((status) => [status, 0] as const),
        ...groups.map((group) => [group.status, group._count._all] as const),
      ]);
      return {
        stationId,
        attendance,
        orders: {
          dataSource: 'database' as const,
          totalOrders: groups.reduce(
            (total, group) => total + group._count._all,
            0,
          ),
          countsByStatus,
        },
      };
    });
  },
};
