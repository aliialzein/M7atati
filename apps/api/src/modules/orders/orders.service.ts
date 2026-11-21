import { prisma } from '../../database/prisma.js';
import type { UserProfile } from '../auth/auth.types.js';
import { requireManagedStation } from '../../utils/accessScope.js';
import { demoOrdersForStation, selectDemoOrders } from './orders.demo.js';
import type { ListOrdersInput } from './orders.validation.js';

export const ordersService = {
  async list(actor: UserProfile, stationId: number, input: ListOrdersInput) {
    // Authorize before consulting demo data, including empty selections. This is
    // the only resource DB operation; the demo data never touches FuelOrder.
    await requireManagedStation(actor, stationId, prisma);
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
