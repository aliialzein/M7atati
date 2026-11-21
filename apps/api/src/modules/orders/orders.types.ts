export const demoOrderStatuses = ['PENDING', 'COMPLETED', 'CANCELLED'] as const;
export type DemoOrderStatus = (typeof demoOrderStatuses)[number];

// Demo IDs are stable and distinct from the persistent FuelOrder contract.
export interface DemoOrder {
  readonly id: number;
  readonly stationId: number;
  readonly status: DemoOrderStatus;
  readonly createdAt: string;
  readonly orderedAmountMinor: number;
  readonly currency: 'USD';
}

export interface DemoOrderFilters {
  readonly from?: Date;
  readonly to?: Date;
  readonly minAmountMinor?: number;
  readonly maxAmountMinor?: number;
  readonly status?: DemoOrderStatus;
}
