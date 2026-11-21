import type { UserProfile } from '../auth/auth.types.js';
import { requireManagedStation } from '../../utils/accessScope.js';
import {
  demoOrdersForStation,
  selectDemoOrders,
} from '../orders/orders.demo.js';
import type { DemoOrderStatus } from '../orders/orders.types.js';
import { analyticsRepository } from './analytics.repository.js';
import type { StationAnalyticsInput } from './analytics.validation.js';

export const analyticsService = {
  async station(
    actor: UserProfile,
    stationId: number,
    input: StationAnalyticsInput,
  ) {
    return analyticsRepository.transaction(async (tx) => {
      // Authorize before both sections, including empty selections and demo data.
      await requireManagedStation(actor, stationId, tx);
      const attendance = await analyticsRepository.attendance(
        stationId,
        input,
        tx,
      );
      const selected = selectDemoOrders(
        demoOrdersForStation(stationId),
        stationId,
        input,
      );
      const countsByStatus: Record<DemoOrderStatus, number> = {
        PENDING: 0,
        COMPLETED: 0,
        CANCELLED: 0,
      };
      let completedOrderedAmountMinor = 0;
      for (const order of selected) {
        countsByStatus[order.status]++;
        if (order.status === 'COMPLETED')
          completedOrderedAmountMinor += order.orderedAmountMinor;
      }
      return {
        stationId,
        attendance,
        orders: {
          dataSource: 'demo' as const,
          currency: 'USD' as const,
          totalOrders: selected.length,
          countsByStatus,
          completedOrderedAmountMinor,
        },
      };
    });
  },
};
