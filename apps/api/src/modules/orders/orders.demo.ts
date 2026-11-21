import type {
  DemoOrder,
  DemoOrderFilters,
  DemoOrderStatus,
} from './orders.types.js';

// Fixed UTC dates, no clock/randomness, database access, or startup seeding.
// Materialize fresh records for any authorized local station, without keeping a
// mutable shared cache. IDs use stationId * 100 + sequence (safe for int32 IDs).
const templates: readonly (readonly [string, DemoOrderStatus, number])[] = [
  ['2026-11-18T22:00:00.000Z', 'CANCELLED', 0],
  ['2026-11-19T00:00:00.000Z', 'PENDING', 2500],
  ['2026-11-19T12:00:00.000Z', 'COMPLETED', 5000],
  ['2026-11-19T12:00:00.000Z', 'PENDING', 5000],
  ['2026-11-20T00:00:00.000Z', 'COMPLETED', 10000],
  ['2026-11-20T08:30:00.000Z', 'CANCELLED', 7500],
  ['2026-11-21T00:00:00.000Z', 'PENDING', 1250],
  ['2026-11-21T12:00:00.000Z', 'COMPLETED', 0],
];

// This pure factory and selector can be reused by future station analytics.
// Callers must authorize the station before requesting its demo records.
export function demoOrdersForStation(stationId: number): readonly DemoOrder[] {
  return templates.map(([createdAt, status, amount], index) => ({
    id: stationId * 100 + index + 1,
    stationId,
    status,
    createdAt,
    orderedAmountMinor: amount === 0 ? 0 : amount + (stationId % 100) * 100,
    currency: 'USD',
  }));
}

// Selection always includes a station, even for mixed fixture sets. No
// pagination here: future analytics can aggregate the entire filtered selection.
export function selectDemoOrders(
  orders: readonly DemoOrder[],
  stationId: number,
  filters: DemoOrderFilters,
): DemoOrder[] {
  return orders
    .filter((order) => {
      const time = Date.parse(order.createdAt);
      return (
        order.stationId === stationId &&
        (filters.from === undefined || time >= filters.from.getTime()) &&
        (filters.to === undefined || time < filters.to.getTime()) &&
        (filters.minAmountMinor === undefined ||
          order.orderedAmountMinor >= filters.minAmountMinor) &&
        (filters.maxAmountMinor === undefined ||
          order.orderedAmountMinor <= filters.maxAmountMinor) &&
        (filters.status === undefined || order.status === filters.status)
      );
    })
    .sort(
      (a, b) =>
        Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id - a.id,
    );
}
