import type { Prisma, OrderQuote } from '../../generated/prisma/client.js';
import type { UserProfile, AuthContext } from '../auth/auth.types.js';
import { HttpError } from '../../types/http-error.js';
import {
  employeeOrdersRepository,
  managerOrdersRepository,
  orderCreationRepository,
  createdOrderSelect,
  cashOrdersRepository,
  confirmedPaymentSelect,
  orderTrackingRepository,
  orderCancellationRepository,
} from './orders.repository.js';
import {
  employeeOrderTransitions,
  orderStatus,
  type EmployeeOrderAction,
} from './orders.types.js';
import type {
  ListOrdersInput,
  EmployeeOrdersInput,
  EmployeeWorkInput,
  QuoteInput,
  CreateOrderInput,
  CashConfirmationInput,
  CustomerOrderHistoryInput,
} from './orders.validation.js';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { calculateQuote, moneyString } from './orders.pricing.js';
import { currencySchema } from '../fuel-prices/fuel-prices.validation.js';
import {
  guestOrderAccessToken,
  matchesGuestOrderAccessToken,
} from './orders.guest-access.js';

export const ordersService = {
  async list(actor: UserProfile, stationId: number, input: ListOrdersInput) {
    return managerOrdersRepository.transaction(async (tx) => {
      await managerOrdersRepository.managedStation(actor, stationId, tx);
      const { orders, total } = await managerOrdersRepository.list(
        stationId,
        input,
        tx,
      );
      return {
        dataSource: 'database' as const,
        stationId,
        orders,
        pagination: pagination({ page: input.page, limit: input.limit }, total),
      };
    });
  },
  async detail(actor: UserProfile, stationId: number, orderId: number) {
    return managerOrdersRepository.transaction(async (tx) => {
      await managerOrdersRepository.managedStation(actor, stationId, tx);
      const order = await managerOrdersRepository.detail(
        orderId,
        stationId,
        tx,
      );
      if (!order) throw new HttpError('Order not found', 404);
      return { dataSource: 'database' as const, stationId, order };
    });
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
  // A status change must not commit between checking station activity and the
  // order/event writes. Keep the station lock until this transaction finishes.
  const station = write
    ? await employeeOrdersRepository.lockStation(employee.stationId, tx)
    : employee.station;
  if (!station?.isActive)
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
  transition(actor: UserProfile, id: number, action: EmployeeOrderAction) {
    return employeeOrdersRepository.writeTransaction(async (tx) => {
      const employee = await assignedEmployee(actor, tx, true);
      const order = await employeeOrdersRepository.detail(
        id,
        employee.stationId,
        tx,
      );
      if (!order) throw new HttpError('Order not found', 404);
      const own = order.assignedEmployeeId === employee.id;
      const transition = employeeOrderTransitions[action];
      // Resolve retries only after current authorization. A delayed claim retry
      // after completion acknowledges that original claim without moving backward.
      if (
        own &&
        (order.status === orderStatus.COMPLETED ||
          (action === 'claim' && order.status === orderStatus.IN_PROGRESS))
      )
        return {
          dataSource: 'database' as const,
          stationId: employee.stationId,
          order,
        };
      if (
        action === 'claim'
          ? order.status !== transition.from ||
            order.assignedEmployeeId !== null
          : order.status !== transition.from || !own
      )
        throw new HttpError(
          'Order is no longer available or its status changed',
          409,
        );
      // Active orders are pump reservations (partial unique index). Claim
      // preserves that entry; completion releases it atomically with its event.
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
        transition.from,
        transition.to,
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
      const employee = await assignedEmployee(actor, tx);
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

const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
async function creationCustomer(
  context: AuthContext | undefined,
  tx: Prisma.TransactionClient,
) {
  if (!context) return null;
  await employeeOrdersRepository.lockEmployee(context.user.id, tx);
  const actor = await employeeOrdersRepository.employee(context.user.id, tx);
  if (!actor?.isActive) throw new HttpError('Unauthenticated', 401);
  if (
    actor.role.name !== 'CUSTOMER' ||
    !actor.role.permissions.some(
      ({ permission }) => permission.key === 'orders.create',
    )
  )
    throw new HttpError('Insufficient permissions', 403);
  return actor.id;
}
async function activeStation(id: number, tx: Prisma.TransactionClient) {
  const station = await employeeOrdersRepository.lockStation(id, tx);
  if (!station?.isActive) throw new HttpError('Station is unavailable', 409);
}
function quoteJson(row: OrderQuote) {
  const currency = currencySchema.parse(row.currency);
  return {
    id: row.id,
    stationId: row.stationId,
    fuelTypeId: row.fuelTypeId,
    sellingPriceId: row.sellingPriceId,
    fulfillmentType: row.fulfillmentType,
    currency,
    unitPriceMinor: row.unitPriceMinor,
    unitPrice: moneyString(row.unitPriceMinor, currency),
    quantity: row.quantity.toFixed(3),
    totalMinor: row.totalMinor,
    total: moneyString(row.totalMinor, currency),
    inputMode: row.inputMode,
    requestedValue: row.requestedValue,
    expiresAt: row.expiresAt,
  };
}
function ownsQuote(
  quote: OrderQuote,
  customerId: number | null,
  guestToken?: string,
) {
  if (quote.customerId !== null) return quote.customerId === customerId;
  if (customerId !== null || !quote.guestTokenHash || !guestToken) return false;
  const supplied = Buffer.from(hash(guestToken), 'hex');
  const expected = Buffer.from(quote.guestTokenHash, 'hex');
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}
export const orderCreationService = {
  quote(context: AuthContext | undefined, input: QuoteInput) {
    const guestToken = context ? undefined : randomBytes(32).toString('hex');
    return orderCreationRepository.transaction(async (tx) => {
      const customerId = await creationCustomer(context, tx);
      if (input.fulfillmentType === 'PICKUP' && customerId === null)
        throw new HttpError('Customer login is required for pickup', 401);
      await activeStation(input.stationId, tx);
      if (
        !(await tx.fuelType.findUnique({
          where: { id: input.fuelTypeId },
          select: { id: true },
        }))
      )
        throw new HttpError('Fuel type not found', 404);
      const now = new Date();
      const price = await tx.sellingPrice.findFirst({
        where: {
          fuelTypeId: input.fuelTypeId,
          currency: input.currency,
          effectiveAt: { lte: now },
        },
        orderBy: [{ effectiveAt: 'desc' }, { id: 'desc' }],
      });
      if (!price)
        throw new HttpError('No effective selling price is configured', 409);
      const calculated = calculateQuote(
        price.unitPriceMinor,
        input.currency,
        input.inputMode,
        input.value,
      );
      const quote = await tx.orderQuote.create({
        data: {
          stationId: input.stationId,
          fuelTypeId: input.fuelTypeId,
          sellingPriceId: price.id,
          customerId,
          guestTokenHash: guestToken ? hash(guestToken) : null,
          currency: input.currency,
          fulfillmentType: input.fulfillmentType,
          unitPriceMinor: price.unitPriceMinor,
          quantity: calculated.quantity,
          totalMinor: calculated.totalMinor,
          inputMode: input.inputMode,
          requestedValue: input.value,
          expiresAt: new Date(now.getTime() + 10 * 60 * 1000),
        },
      });
      return { quote: quoteJson(quote), ...(guestToken ? { guestToken } : {}) };
    });
  },
  create(context: AuthContext | undefined, input: CreateOrderInput) {
    const requestHash = hash(
      JSON.stringify({
        quoteId: input.quoteId,
        customerName: input.customerName ?? null,
        customerPhone: input.customerPhone ?? null,
      }),
    );
    return orderCreationRepository.transaction(async (tx) => {
      // Lock order: customer (if any), quote, station, then new order/event.
      // Station deactivation never acquires customer or quote locks.
      const customerId = await creationCustomer(context, tx);
      await orderCreationRepository.lockQuote(input.quoteId, tx);
      const quote = await tx.orderQuote.findUnique({
        where: { id: input.quoteId },
      });
      if (!quote || !ownsQuote(quote, customerId, input.guestToken))
        throw new HttpError('Quote not found', 404);
      const existing = await tx.fuelOrder.findUnique({
        where: { creationKey: input.idempotencyKey },
      });
      if (existing) {
        if (
          existing.quoteId !== quote.id ||
          existing.creationRequestHash !== requestHash
        )
          throw new HttpError(
            'Idempotency key was used for a different request',
            409,
          );
        // A completed creation remains replayable after quote expiry or station
        // deactivation. Current identity is still checked before returning it.
        const order = await tx.fuelOrder.findUniqueOrThrow({
          where: { id: existing.id },
          select: createdOrderSelect,
        });
        return {
          order,
          replayed: true,
          ...(customerId === null
            ? { guestAccessToken: guestOrderAccessToken(order.id, quote) }
            : {}),
        };
      }
      if (
        await tx.fuelOrder.findUnique({
          where: { quoteId: quote.id },
          select: { id: true },
        })
      )
        throw new HttpError('Quote already created an order', 409);
      await activeStation(quote.stationId, tx);
      if (quote.expiresAt.getTime() <= Date.now())
        throw new HttpError('Quote has expired', 409);
      // A valid quote holds its immutable price until expiry; tariff changes
      // never reprice it silently. Neither price nor totals come from this request.
      const order = await tx.fuelOrder.create({
        data: {
          quoteId: quote.id,
          creationKey: input.idempotencyKey,
          creationRequestHash: requestHash,
          stationId: quote.stationId,
          fuelTypeId: quote.fuelTypeId,
          userId: customerId,
          source: customerId === null ? 'GUEST' : 'CUSTOMER',
          fulfillmentType: quote.fulfillmentType,
          currency: quote.currency,
          pumpId: null,
          status: orderStatus.AWAITING_PAYMENT,
          unitPriceMinor: quote.unitPriceMinor,
          orderedVolume: quote.quantity,
          orderedAmountMinor: quote.totalMinor,
          customerName: input.customerName,
          customerPhone: input.customerPhone,
        },
        select: createdOrderSelect,
      });
      await tx.orderEvent.create({
        data: {
          orderId: order.id,
          actorUserId: customerId,
          actorType: customerId === null ? 'GUEST' : 'CUSTOMER',
          fromStatus: null,
          toStatus: orderStatus.AWAITING_PAYMENT,
        },
      });
      return {
        order,
        replayed: false,
        ...(customerId === null
          ? { guestAccessToken: guestOrderAccessToken(order.id, quote) }
          : {}),
      };
    });
  },
};

const cash = { method: 'CASH', status: 'CONFIRMED' } as const;

export const cashOrdersService = {
  confirm(
    actor: UserProfile,
    stationId: number,
    orderId: number,
    input: CashConfirmationInput,
  ) {
    return cashOrdersRepository.transaction(async (tx) => {
      // Same ordering as fulfillment: user -> station -> order -> pump.
      // Existing station/user maintenance never takes these locks in reverse.
      await employeeOrdersRepository.lockEmployee(actor.id, tx);
      const manager = await employeeOrdersRepository.employee(actor.id, tx);
      if (!manager?.isActive) throw new HttpError('Unauthenticated', 401);
      if (
        actor.role !== 'MANAGER' ||
        manager.role.name !== 'MANAGER' ||
        !manager.role.permissions.some(
          ({ permission }) => permission.key === 'payments.manage',
        )
      )
        throw new HttpError('Insufficient permissions', 403);
      const station = await cashOrdersRepository.lockStation(stationId, tx);
      if (!station || station.managerId !== manager.id)
        throw new HttpError('Station not found', 404);
      const order = await cashOrdersRepository.lockOrder(
        orderId,
        stationId,
        tx,
      );
      if (!order) throw new HttpError('Order not found', 404);
      if (
        order.currency !== input.currency ||
        order.orderedAmountMinor !== input.amountMinor
      )
        throw new HttpError(
          'Payment must match the exact order total and currency',
          409,
        );

      const { payments, ...snapshot } = order;
      if (payments.length) {
        const payment = payments[0]!;
        if (
          payments.length === 1 &&
          payment.method === cash.method &&
          payment.status === cash.status &&
          payment.confirmedById !== null &&
          payment.confirmedAt !== null &&
          payment.currency === input.currency &&
          payment.amountMinor === input.amountMinor &&
          payment.capturedMinor === input.amountMinor &&
          order.pumpId === input.pumpId &&
          (
            [
              orderStatus.PENDING,
              orderStatus.IN_PROGRESS,
              orderStatus.COMPLETED,
            ] as string[]
          ).includes(order.status)
        ) {
          // A retry acknowledges the original confirmation after fulfillment or
          // station/pump deactivation. It performs no new activation.
          return {
            dataSource: 'database' as const,
            stationId,
            order: snapshot,
            payment,
            replayed: true,
          };
        }
        throw new HttpError(
          'Order already has a payment or conflicting confirmation',
          409,
        );
      }
      if (!station.isActive) throw new HttpError('Station is inactive', 409);
      if (
        order.status !== orderStatus.AWAITING_PAYMENT ||
        order.assignedEmployeeId !== null ||
        order.claimedAt !== null
      )
        throw new HttpError('Order is not awaiting payment', 409);
      const pump = await cashOrdersRepository.lockPump(input.pumpId, tx);
      // IDLE is the existing operational convention (fixtures); unknown states
      // fail closed. There is no pump isActive field or fuel-assignment rule.
      if (!pump || pump.stationId !== stationId || pump.status !== 'IDLE')
        throw new HttpError(
          'Select an IDLE pump belonging to this station',
          409,
        );
      if (await cashOrdersRepository.activePumpOrder(pump.id, tx))
        throw new HttpError('Pump is already reserved by an active order', 409);
      const changed = await tx.fuelOrder.updateMany({
        where: {
          id: orderId,
          stationId,
          status: orderStatus.AWAITING_PAYMENT,
          assignedEmployeeId: null,
          claimedAt: null,
        },
        data: { status: orderStatus.PENDING, pumpId: pump.id },
      });
      if (changed.count !== 1)
        throw new HttpError('Order status changed; retry request', 409);
      const payment = await tx.payment.create({
        data: {
          orderId,
          ...cash,
          currency: input.currency,
          amountMinor: input.amountMinor,
          capturedMinor: input.amountMinor,
          confirmedById: manager.id,
          confirmedAt: new Date(),
        },
        select: confirmedPaymentSelect,
      });
      await tx.orderEvent.create({
        data: {
          orderId,
          actorUserId: manager.id,
          actorType: 'MANAGER',
          fromStatus: orderStatus.AWAITING_PAYMENT,
          toStatus: orderStatus.PENDING,
          note: 'Cash payment confirmed',
        },
      });
      return {
        dataSource: 'database' as const,
        stationId,
        order: { ...snapshot, status: orderStatus.PENDING, pumpId: pump.id },
        payment,
        replayed: false,
      };
    });
  },
};

async function trackingCustomer(
  context: AuthContext | undefined,
  tx: Prisma.TransactionClient,
  permission: 'orders.read' | 'orders.cancel' = 'orders.read',
) {
  if (!context) throw new HttpError('Unauthenticated', 401);
  const actor = await employeeOrdersRepository.employee(context.user.id, tx);
  if (!actor?.isActive) throw new HttpError('Unauthenticated', 401);
  if (
    context.user.role !== 'CUSTOMER' ||
    actor.role.name !== 'CUSTOMER' ||
    !actor.role.permissions.some((entry) => entry.permission.key === permission)
  )
    throw new HttpError('Insufficient permissions', 403);
  return actor.id;
}

export async function ownedOrder(
  context: AuthContext | undefined,
  id: number,
  credential: unknown,
  tx: Prisma.TransactionClient,
  permission: 'orders.read' | 'orders.cancel' = 'orders.read',
) {
  if (context) {
    const customerId = await trackingCustomer(context, tx, permission);
    const order = await orderTrackingRepository.customerOrder(
      id,
      customerId,
      tx,
    );
    if (!order) throw new HttpError('Order not found', 404);
    return order;
  }
  // Missing, malformed and incorrect credentials do not disclose existence.
  if (typeof credential !== 'string' || !/^[a-f0-9]{64}$/.test(credential))
    throw new HttpError('Order not found', 404);
  const row = await orderTrackingRepository.guestOrder(id, tx);
  if (!row) throw new HttpError('Order not found', 404);
  const { quote, ...order } = row;
  if (
    !quote ||
    !matchesGuestOrderAccessToken(guestOrderAccessToken(id, quote), credential)
  )
    throw new HttpError('Order not found', 404);
  return order;
}

export const orderTrackingService = {
  mine(context: AuthContext | undefined, input: CustomerOrderHistoryInput) {
    return orderTrackingRepository.transaction(async (tx) => {
      const customerId = await trackingCustomer(context, tx);
      return orderTrackingRepository.mine(customerId, input, tx);
    });
  },
  read(
    context: AuthContext | undefined,
    id: number,
    credential: unknown,
    history = false,
  ) {
    return orderTrackingRepository.transaction(async (tx) => {
      const order = await ownedOrder(context, id, credential, tx);
      if (history)
        return {
          orderId: order.id,
          status: order.status,
          events: await orderTrackingRepository.events(order.id, tx),
        };
      return { order };
    });
  },
};

export const orderCancellationService = {
  cancel(context: AuthContext | undefined, id: number, credential: unknown) {
    return employeeOrdersRepository.writeTransaction(async (tx) => {
      // Customer -> order. Guests lock only the order. Do not take station or
      // pump locks after the order: cash takes station -> order -> pump.
      if (context)
        await employeeOrdersRepository.lockEmployee(context.user.id, tx);
      // Authorize before taking the order lock. A cash write between this read
      // and FOR UPDATE causes a Serializable retry with fresh authorization.
      await ownedOrder(context, id, credential, tx, 'orders.cancel');
      const current = await orderCancellationRepository.lockOrder(id, tx);
      if (!current) throw new HttpError('Order not found', 404);
      if (
        current.payments.length ||
        current.pumpId !== null ||
        current.assignedEmployeeId !== null ||
        current.claimedAt !== null
      )
        throw new HttpError(
          'Only unpaid, unassigned orders can be cancelled',
          409,
        );
      if (current.status === orderStatus.CANCELLED)
        return {
          order: await orderCancellationRepository.result(id, tx),
          replayed: true,
        };
      if (current.status !== orderStatus.AWAITING_PAYMENT)
        throw new HttpError(
          'Only orders awaiting payment can be cancelled',
          409,
        );
      const changed = await orderCancellationRepository.cancel(id, tx);
      if (changed.count !== 1)
        throw new HttpError('Order changed; retry request', 409);
      await tx.orderEvent.create({
        data: {
          orderId: id,
          actorUserId: context?.user.id ?? null,
          actorType: context ? 'CUSTOMER' : 'GUEST',
          fromStatus: orderStatus.AWAITING_PAYMENT,
          toStatus: orderStatus.CANCELLED,
        },
      });
      return {
        order: await orderCancellationRepository.result(id, tx),
        replayed: false,
      };
    });
  },
};
