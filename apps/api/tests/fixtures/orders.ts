import { Decimal } from '@prisma/client/runtime/client';

// Persisted-row doubles only: no application demo factory or database writes.
export interface OrderFixture extends Record<string, unknown> {
  id: number;
  stationId: number;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  orderedAmountMinor: number;
  assignedEmployeeId: number | null;
  claimedAt: Date | null;
  assignee: Record<string, unknown> | null;
  events: Record<string, unknown>[];
}

export function orderFixtures(stationId: number): OrderFixture[] {
  const rows = [
    ['2026-11-18T22:00:00Z', 'CANCELLED', 0],
    ['2026-11-19T00:00:00Z', 'PENDING', 2500],
    ['2026-11-19T12:00:00Z', 'COMPLETED', 5000],
    ['2026-11-19T12:00:00Z', 'PENDING', 5000],
    ['2026-11-20T00:00:00Z', 'COMPLETED', 10000],
    ['2026-11-20T08:30:00Z', 'CANCELLED', 7500],
    ['2026-11-21T00:00:00Z', 'IN_PROGRESS', 1250],
    ['2026-11-21T12:00:00Z', 'COMPLETED', 0],
  ] as const;
  return rows.map(([date, status, amount], index) => {
    const assignedEmployeeId = ['IN_PROGRESS', 'COMPLETED'].includes(status)
      ? 3
      : null;
    return {
      id: stationId * 100 + index + 1,
      stationId,
      status,
      createdAt: new Date(date),
      updatedAt: new Date(date),
      source: 'PERSISTED_TEST',
      currency: null,
      fulfillmentType: null,
      pumpId: stationId,
      pump: { id: stationId, number: 1 },
      fuelTypeId: 1,
      fuelType: { id: 1, code: 'TEST', name: 'Test fuel' },
      orderedVolume: new Decimal('25.125'),
      unitPriceMinor: 100,
      orderedAmountMinor: amount === 0 ? 0 : amount + (stationId % 100) * 100,
      finalMinor: null,
      dispensedVolume: null,
      scheduledFor: null,
      expiresAt: null,
      assignedEmployeeId,
      claimedAt: assignedEmployeeId === null ? null : new Date(date),
      assignee:
        assignedEmployeeId === null
          ? null
          : {
              id: assignedEmployeeId,
              name: 'Historical employee',
              isActive: false,
              email: 'private@example.invalid',
              passwordHash: 'private-secret',
            },
      customerName: 'private-customer',
      customerPhone: 'private-phone',
      notes: 'private-notes',
      payments: [{ provider: 'private-payment' }],
      events: [],
    };
  });
}

export type OrderWhere = {
  stationId: number;
  id?: number;
  status?: string;
  assignedEmployeeId?: number | null;
  createdAt?: { gte?: Date; lt?: Date };
  orderedAmountMinor?: { gte?: number; lte?: number };
};

export function matchesOrder(row: OrderFixture, where: OrderWhere) {
  return (
    row.stationId === where.stationId &&
    (where.id === undefined || row.id === where.id) &&
    (where.status === undefined || row.status === where.status) &&
    (where.assignedEmployeeId === undefined ||
      row.assignedEmployeeId === where.assignedEmployeeId) &&
    (!where.createdAt?.gte || row.createdAt >= where.createdAt.gte) &&
    (!where.createdAt?.lt || row.createdAt < where.createdAt.lt) &&
    (where.orderedAmountMinor?.gte === undefined ||
      row.orderedAmountMinor >= where.orderedAmountMinor.gte) &&
    (where.orderedAmountMinor?.lte === undefined ||
      row.orderedAmountMinor <= where.orderedAmountMinor.lte)
  );
}

export function selectFields(
  row: Record<string, unknown>,
  select: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(select).map(([key, rule]) => {
      const value = row[key];
      if (rule === true || value === null) return [key, value];
      const nested = rule as {
        select: Record<string, unknown>;
        orderBy?: unknown;
      };
      if (Array.isArray(value)) {
        const records = [...value] as Record<string, unknown>[];
        if (nested.orderBy)
          records.sort(
            (a, b) =>
              Number(a.createdAt) - Number(b.createdAt) ||
              Number(a.id) - Number(b.id),
          );
        return [
          key,
          records.map((entry) => selectFields(entry, nested.select)),
        ];
      }
      return [
        key,
        selectFields(value as Record<string, unknown>, nested.select),
      ];
    }),
  );
}
