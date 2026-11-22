// Stored values remain strings for compatibility with existing orders.
export const orderStatus = {
  AWAITING_PAYMENT: 'AWAITING_PAYMENT',
  PENDING: 'PENDING',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
} as const;
export type OrderStatus = (typeof orderStatus)[keyof typeof orderStatus];
export const orderStatuses = [
  orderStatus.AWAITING_PAYMENT,
  orderStatus.PENDING,
  orderStatus.IN_PROGRESS,
  orderStatus.COMPLETED,
  orderStatus.CANCELLED,
] as const;

export interface OrderFilters {
  readonly from?: Date;
  readonly to?: Date;
  readonly minAmountMinor?: number;
  readonly maxAmountMinor?: number;
  readonly status?: OrderStatus;
}

export const employeeOrderTransitions = {
  claim: { from: orderStatus.PENDING, to: orderStatus.IN_PROGRESS },
  complete: { from: orderStatus.IN_PROGRESS, to: orderStatus.COMPLETED },
} as const;
export type EmployeeOrderAction = keyof typeof employeeOrderTransitions;

// Retained for standalone demo fixtures; Manager endpoints use persisted orders.
export const demoOrderStatuses = [
  orderStatus.PENDING,
  orderStatus.COMPLETED,
  orderStatus.CANCELLED,
] as const;
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
