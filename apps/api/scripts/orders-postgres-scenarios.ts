import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { ErrorRequestHandler } from 'express';
import type { Prisma } from '../src/generated/prisma/client.js';
import type { UserProfile } from '../src/modules/auth/auth.types.js';
import { provisionCustomerOrderCancellation } from './customer-order-permissions.js';

// Called only by the guarded runner, after database identity and migrations have
// been verified. Exercises the real Express middleware and real Prisma client.
export async function runOrdersPostgresScenarios() {
  const { prisma } = await import('../src/database/prisma.js');
  const { app } = await import('../src/app.js');
  const { errorHandler } = await import('../src/middleware/errorHandler.js');
  const errorLayer = (
    app as unknown as {
      _router: { stack: { handle: ErrorRequestHandler }[] };
    }
  )._router.stack.find((layer) => layer.handle === errorHandler);
  assert(errorLayer, 'Expected shared error handler for verifier diagnostics');
  // Harness-only observation; delegate unchanged so the HTTP contract is preserved.
  errorLayer.handle = (error: unknown, req, res, next) => {
    const failure = error as {
      name?: string;
      code?: string;
      message?: string;
      meta?: {
        code?: string;
        driverAdapterError?: {
          cause?: {
            originalCode?: string;
            kind?: string;
          };
        };
      };
    };
    const message = failure.message ?? '';
    console.error(
      JSON.stringify({
        method: req.method,
        path: req.path,
        errorType: failure.name,
        prismaCode: failure.code,
        sqlState:
          failure.meta?.code ??
          failure.meta?.driverAdapterError?.cause?.originalCode,
        driverKind: failure.meta?.driverAdapterError?.cause?.kind,
        unsupportedColumnType: message.match(
          /Failed to deserialize column of type '([^']+)'/,
        )?.[1],
        unknownArgument: message.match(
          /Unknown argument `([a-zA-Z0-9_]+)`/,
        )?.[1],
      }),
    );
    errorHandler(error, req, res, next);
  };
  const { env } = await import('../src/config/env.js');
  const { tokenService } = await import('../src/modules/auth/token.service.js');
  const { ACCESS_COOKIE } = await import('../src/modules/auth/auth.types.js');
  const {
    cashOrdersRepository,
    orderCancellationRepository,
    employeeOrdersRepository,
  } = await import('../src/modules/orders/orders.repository.js');
  const originalLockOrder = cashOrdersRepository.lockOrder;
  cashOrdersRepository.lockOrder = async (id, stationId, tx) => {
    try {
      return await originalLockOrder(id, stationId, tx);
    } catch (error) {
      const failure = error as { code?: string };
      console.error(
        JSON.stringify({
          transactionStep: 'cash lockOrder FOR UPDATE',
          orderId: id,
          stationId,
          prismaCode: failure.code,
        }),
      );
      throw error;
    }
  };
  const run = randomUUID();
  let phase = 'fixture setup';
  try {
    const role = async (name: string, keys: string[]) => {
      const result = await prisma.role.upsert({
        where: { name },
        update: {},
        create: { name },
      });
      for (const key of keys) {
        const permission = await prisma.permission.upsert({
          where: { key },
          update: {},
          create: { key },
        });
        await prisma.rolePermission.upsert({
          where: {
            roleId_permissionId: {
              roleId: result.id,
              permissionId: permission.id,
            },
          },
          update: {},
          create: { roleId: result.id, permissionId: permission.id },
        });
      }
      return result;
    };
    const adminRole = await role('ADMIN', [
      'pricing.read',
      'pricing.update',
      'payments.manage',
    ]);
    const managerRole = await role('MANAGER', [
      'orders.read',
      'payments.manage',
      'attendance.read',
      'reports.read',
    ]);
    const employeeRole = await role('EMPLOYEE', [
      'orders.read',
      'orders.update',
      'payments.manage',
    ]);
    const customerRole = await role('CUSTOMER', [
      'orders.read',
      'orders.create',
    ]);
    const grants = () =>
      prisma.rolePermission.findMany({
        orderBy: [{ roleId: 'asc' }, { permissionId: 'asc' }],
      });
    const before = await grants();
    await provisionCustomerOrderCancellation(prisma);
    const once = await grants();
    await provisionCustomerOrderCancellation(prisma);
    assert.deepEqual(await grants(), once);
    assert(
      before.every((old) =>
        once.some(
          (current) =>
            old.roleId === current.roleId &&
            old.permissionId === current.permissionId,
        ),
      ),
    );
    const cancellation = await prisma.permission.findUniqueOrThrow({
      where: { key: 'orders.cancel' },
    });
    assert.equal(
      await prisma.rolePermission.count({
        where: { roleId: customerRole.id, permissionId: cancellation.id },
      }),
      1,
    );
    assert(
      once
        .filter(
          (link) =>
            !before.some(
              (old) =>
                old.roleId === link.roleId &&
                old.permissionId === link.permissionId,
            ),
        )
        .every(
          (link) =>
            link.roleId === customerRole.id &&
            link.permissionId === cancellation.id,
        ),
    );
    console.info(
      'PASS: additive Customer orders.cancel provisioning and idempotency',
    );
    const person = async (
      roleId: number,
      roleName: string,
      stationId: number | null = null,
    ): Promise<UserProfile> => {
      const user = await prisma.user.create({
        data: {
          roleId,
          stationId,
          name: `Stage9 ${run}`,
          email: `${randomUUID()}@stage9.invalid`,
          passwordHash: '!No-login-disposable-verification',
        },
      });
      return {
        id: user.id,
        name: user.name,
        email: user.email,
        stationId,
        role: roleName,
      };
    };
    const admin = await person(adminRole.id, 'ADMIN');
    const manager = await person(managerRole.id, 'MANAGER');
    const outsider = await person(managerRole.id, 'MANAGER');
    const customer = await person(customerRole.id, 'CUSTOMER');
    const otherCustomer = await person(customerRole.id, 'CUSTOMER');
    const station = await prisma.station.create({
      data: { name: `Stage9 ${run}`, managerId: manager.id },
    });
    const foreign = await prisma.station.create({
      data: { name: `Stage9 foreign ${run}`, managerId: outsider.id },
    });
    const employee = await person(employeeRole.id, 'EMPLOYEE', station.id);
    const foreignEmployee = await person(
      employeeRole.id,
      'EMPLOYEE',
      foreign.id,
    );
    const pump = await prisma.pump.create({
      data: { stationId: station.id, number: 1, status: 'IDLE' },
    });
    const foreignPump = await prisma.pump.create({
      data: { stationId: foreign.id, number: 1, status: 'IDLE' },
    });
    const offline = await prisma.pump.create({
      data: { stationId: station.id, number: 2, status: 'OFFLINE' },
    });
    const fuel = await prisma.fuelType.create({
      data: { code: `STAGE9_${run}`, name: `Stage9 ${run}` },
    });
    console.info(
      `Fixtures: run=${run} station=${station.id} foreignStation=${foreign.id}; retained after execution`,
    );
    const cookie = (actor: UserProfile) =>
      `${ACCESS_COOKIE}=${tokenService.issue(actor.id).accessToken}`;
    const post = async (
      path: string,
      body: object,
      expected: number,
      actor?: UserProfile,
      credential?: string,
    ) => {
      const pending = request(app)
        .post(`/api${path}`)
        .set('Origin', env.allowedOrigins[0])
        .set('X-CSRF-Protection', '1')
        .send(body)
        .timeout(12000);
      if (actor) pending.set('Cookie', cookie(actor));
      if (credential) pending.set('X-Order-Access-Token', credential);
      const response = await pending;
      if (response.status !== expected)
        console.error(
          JSON.stringify({
            method: 'POST',
            path: `/api${path}`,
            expected,
            actual: response.status,
            response:
              response.status === 500
                ? {
                    message:
                      response.body.message === 'Internal Server Error'
                        ? response.body.message
                        : '[redacted unexpected message]',
                  }
                : undefined,
          }),
        );
      assert.equal(response.status, expected, `POST ${path}`);
      return response;
    };
    const get = async (
      path: string,
      expected: number,
      actor?: UserProfile,
      credential?: string,
    ) => {
      const pending = request(app).get(`/api${path}`).timeout(12000);
      if (actor) pending.set('Cookie', cookie(actor));
      if (credential) pending.set('X-Order-Access-Token', credential);
      const response = await pending;
      if (response.status !== expected)
        console.error(
          JSON.stringify({
            method: 'GET',
            path: `/api${path}`,
            expected,
            actual: response.status,
            response:
              response.status === 500
                ? {
                    message:
                      response.body.message === 'Internal Server Error'
                        ? response.body.message
                        : '[redacted unexpected message]',
                  }
                : undefined,
          }),
        );
      assert.equal(response.status, expected, `GET ${path}`);
      return response;
    };
    const quoteBody = {
      stationId: station.id,
      fuelTypeId: fuel.id,
      currency: 'USD',
      fulfillmentType: 'IN_STATION',
      inputMode: 'LITERS',
      value: '1.250',
    };
    type Created = {
      order: { id: number; orderedAmountMinor: number; currency: string };
      guestAccessToken?: string;
      replayed: boolean;
    };
    const mint = async (actor?: UserProfile) => {
      const response = await post(
        '/orders/quotes',
        { ...quoteBody, fulfillmentType: actor ? 'PICKUP' : 'IN_STATION' },
        201,
        actor,
      );
      const quote = response.body as {
        quote: { id: string };
        guestToken?: string;
      };
      const input = {
        quoteId: quote.quote.id,
        idempotencyKey: randomUUID(),
        ...(quote.guestToken ? { guestToken: quote.guestToken } : {}),
      };
      const created = (await post('/orders', input, 201, actor))
        .body as Created;
      return { created, input, quote };
    };
    const cashPath = (id: number) =>
      `/manager/stations/${station.id}/orders/${id}/confirm-cash`;
    const cashBody = (created: Created, pumpId = pump.id) => ({
      amountMinor: created.order.orderedAmountMinor,
      currency: created.order.currency,
      pumpId,
    });
    const confirmRequest = (created: Created) =>
      request(app)
        .post(`/api${cashPath(created.order.id)}`)
        .set('Cookie', cookie(manager))
        .set('Origin', env.allowedOrigins[0])
        .set('X-CSRF-Protection', '1')
        .send(cashBody(created))
        .timeout(12000);
    const state = (id: number) =>
      prisma.fuelOrder.findUniqueOrThrow({
        where: { id },
        include: {
          payments: true,
          events: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
        },
      });
    const cancel = (created: Created, expected: number, actor?: UserProfile) =>
      post(
        `/orders/${created.order.id}/cancel`,
        {},
        expected,
        actor,
        created.guestAccessToken,
      );
    const trace = async (
      created: Created,
      expected: string,
      actor?: UserProfile,
    ) => {
      const detail = await get(
        `/orders/${created.order.id}`,
        200,
        actor,
        created.guestAccessToken,
      );
      assert.equal(detail.body.order.status, expected);
      assert(
        !('quote' in detail.body.order) &&
          !('payments' in detail.body.order) &&
          !('customerPhone' in detail.body.order),
      );
      return get(
        `/orders/${created.order.id}/events`,
        200,
        actor,
        created.guestAccessToken,
      );
    };

    phase = 'selling prices, quotes, precision and creation idempotency';
    await post('/orders/quotes', quoteBody, 409);
    await post(
      '/fuel-prices/selling',
      {
        fuelTypeId: fuel.id,
        currency: 'USD',
        unitPrice: '1.99',
        effectiveAt: '2020-01-01T00:00:00Z',
      },
      201,
      admin,
    );
    await post(
      '/fuel-prices/selling',
      {
        fuelTypeId: fuel.id,
        currency: 'LBP',
        unitPrice: '90000',
        effectiveAt: '2020-01-01T00:00:00Z',
      },
      201,
      admin,
    );
    await post(
      '/fuel-prices/selling',
      {
        fuelTypeId: fuel.id,
        currency: 'USD',
        unitPrice: '9.99',
        effectiveAt: '2100-01-01T00:00:00Z',
      },
      201,
      admin,
    );
    const budget = await post(
      '/orders/quotes',
      { ...quoteBody, inputMode: 'AMOUNT', value: '0.01' },
      201,
    );
    assert(
      budget.body.quote.totalMinor <= 1 && budget.body.quote.totalMinor > 0,
    );
    const lbp = await post(
      '/orders/quotes',
      { ...quoteBody, currency: 'LBP' },
      201,
    );
    assert.equal(lbp.body.quote.totalMinor, 112500);
    const owned = await mint(customer);
    assert.equal(owned.created.order.orderedAmountMinor, 249);
    const replays = await Promise.all([
      post('/orders', owned.input, 200, customer),
      post('/orders', owned.input, 200, customer),
    ]);
    assert(
      replays.every(
        (response) => response.body.order.id === owned.created.order.id,
      ),
    );
    assert.equal(
      await prisma.fuelOrder.count({
        where: { quoteId: owned.quote.quote.id },
      }),
      1,
    );
    await post(
      '/orders',
      { ...owned.input, customerName: 'Different request' },
      409,
      customer,
    );
    const rawQuote = await post('/orders/quotes', quoteBody, 201);
    const simultaneousInput = {
      quoteId: rawQuote.body.quote.id as string,
      guestToken: rawQuote.body.guestToken as string,
      idempotencyKey: randomUUID(),
    };
    const createRequest = () =>
      request(app)
        .post('/api/orders')
        .set('Origin', env.allowedOrigins[0])
        .set('X-CSRF-Protection', '1')
        .send(simultaneousInput);
    const simultaneous = await Promise.all([createRequest(), createRequest()]);
    assert.deepEqual(
      simultaneous.map((response) => response.status).sort(),
      [200, 201],
    );
    assert.equal(
      await prisma.fuelOrder.count({
        where: { quoteId: simultaneousInput.quoteId },
      }),
      1,
    );
    assert.equal(
      simultaneous[0].body.guestAccessToken,
      simultaneous[1].body.guestAccessToken,
    );
    const expired = await post('/orders/quotes', quoteBody, 201);
    await prisma.orderQuote.update({
      where: { id: expired.body.quote.id },
      data: {
        createdAt: new Date(Date.now() - 1200000),
        expiresAt: new Date(Date.now() - 600000),
      },
    });
    await post(
      '/orders',
      {
        quoteId: expired.body.quote.id,
        guestToken: expired.body.guestToken,
        idempotencyKey: randomUUID(),
      },
      409,
    );
    console.info(`PASS: ${phase}`);

    phase = 'cash activation, fulfillment, history, authorization and replay';
    await prisma.orderQuote.update({
      where: { id: owned.quote.quote.id },
      data: {
        createdAt: new Date(Date.now() - 1200000),
        expiresAt: new Date(Date.now() - 600000),
      },
    });
    await trace(owned.created, 'AWAITING_PAYMENT', customer);
    await get(`/orders/${owned.created.order.id}`, 404, otherCustomer);
    await post(
      `/employee/orders/${owned.created.order.id}/claim`,
      {},
      409,
      employee,
    );
    const queue = await get('/employee/orders', 200, employee);
    assert(
      !queue.body.orders.some(
        (row: { id: number }) => row.id === owned.created.order.id,
      ),
    );
    await post(
      cashPath(owned.created.order.id),
      cashBody(owned.created),
      403,
      admin,
    );
    await post(
      cashPath(owned.created.order.id),
      cashBody(owned.created),
      403,
      employee,
    );
    await post(
      cashPath(owned.created.order.id),
      cashBody(owned.created),
      404,
      outsider,
    );
    await post(
      cashPath(owned.created.order.id),
      cashBody(owned.created, foreignPump.id),
      409,
      manager,
    );
    await post(
      cashPath(owned.created.order.id),
      cashBody(owned.created, offline.id),
      409,
      manager,
    );
    await post(
      cashPath(owned.created.order.id),
      { ...cashBody(owned.created), amountMinor: 250 },
      409,
      manager,
    );
    await post(
      cashPath(owned.created.order.id),
      { ...cashBody(owned.created), currency: 'LBP' },
      409,
      manager,
    );
    const duplicateCash = await Promise.all([
      confirmRequest(owned.created),
      confirmRequest(owned.created),
    ]);
    console.info(
      JSON.stringify({
        operation: 'duplicate cash confirmation',
        method: 'POST',
        path: `/api${cashPath(owned.created.order.id)}`,
        expectedStatuses: [200, 201],
        actualStatuses: duplicateCash.map((response) => response.status),
        errors: duplicateCash
          .filter((response) => response.status === 500)
          .map((response) => ({
            status: response.status,
            body: {
              message:
                response.body.message === 'Internal Server Error'
                  ? response.body.message
                  : '[redacted unexpected message]',
            },
          })),
      }),
    );
    assert.deepEqual(
      duplicateCash.map((response) => response.status).sort(),
      [200, 201],
    );
    await trace(owned.created, 'PENDING', customer);
    await post(
      cashPath(owned.created.order.id),
      cashBody(owned.created),
      200,
      manager,
    );
    await post(
      `/employee/orders/${owned.created.order.id}/claim`,
      {},
      404,
      foreignEmployee,
    );
    await post(
      `/employee/orders/${owned.created.order.id}/claim`,
      {},
      200,
      employee,
    );
    await post(
      `/employee/orders/${owned.created.order.id}/claim`,
      {},
      200,
      employee,
    );
    await trace(owned.created, 'IN_PROGRESS', customer);
    await cancel(owned.created, 409, customer);
    await post(
      `/employee/orders/${owned.created.order.id}/complete`,
      {},
      200,
      employee,
    );
    await post(
      `/employee/orders/${owned.created.order.id}/complete`,
      {},
      200,
      employee,
    );
    const complete = await trace(owned.created, 'COMPLETED', customer);
    assert.deepEqual(
      complete.body.events.map((event: { toStatus: string }) => event.toStatus),
      ['AWAITING_PAYMENT', 'PENDING', 'IN_PROGRESS', 'COMPLETED'],
    );
    const saved = await state(owned.created.order.id);
    assert.equal(saved.payments.length, 1);
    assert.equal(saved.events.length, 4);
    assert.equal(saved.pumpId, pump.id);
    await assert.rejects(
      prisma.payment.create({
        data: {
          orderId: saved.id,
          method: 'CASH',
          status: 'CONFIRMED',
          currency: saved.payments[0].currency,
          amountMinor: saved.payments[0].amountMinor,
          capturedMinor: saved.payments[0].capturedMinor,
          confirmedById: manager.id,
          confirmedAt: new Date(),
        },
      }),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'P2002',
    );
    const detail = await get(
      `/manager/stations/${station.id}/orders/${saved.id}`,
      200,
      manager,
    );
    assert.equal(detail.body.order.status, 'COMPLETED');
    await get(
      `/manager/stations/${station.id}/orders/${saved.id}`,
      404,
      outsider,
    );
    console.info(`PASS: ${phase}`);

    phase =
      'database CHECK constraints reject invalid prices, quote identity and null active pumps';
    const violates = (name: string) => (error: unknown) =>
      String(error).includes(name) || JSON.stringify(error).includes(name);
    await assert.rejects(
      prisma.sellingPrice.create({
        data: {
          fuelTypeId: fuel.id,
          createdBy: admin.id,
          currency: 'USD',
          unitPriceMinor: 0,
          effectiveAt: new Date(),
        },
      }),
      violates('selling_prices_positive_price'),
    );
    const constrained = await mint();
    await assert.rejects(
      prisma.orderQuote.update({
        where: { id: constrained.quote.quote.id },
        data: { customerId: customer.id },
      }),
      violates('order_quotes_identity_check'),
    );
    await assert.rejects(
      prisma.fuelOrder.update({
        where: { id: constrained.created.order.id },
        data: { status: 'PENDING', pumpId: null },
      }),
      violates('orders_active_pump_required_check'),
    );
    assert.equal(
      (await state(constrained.created.order.id)).status,
      'AWAITING_PAYMENT',
    );
    console.info(`PASS: ${phase}`);

    phase = 'guest tracking, unpaid cancellation and isolation';
    const guest = await mint();
    await get(
      `/orders/${guest.created.order.id}`,
      404,
      undefined,
      guest.quote.guestToken,
    );
    await get(
      `/orders/${owned.created.order.id}`,
      404,
      undefined,
      guest.created.guestAccessToken,
    );
    await prisma.orderQuote.update({
      where: { id: guest.quote.quote.id },
      data: {
        createdAt: new Date(Date.now() - 1200000),
        expiresAt: new Date(Date.now() - 600000),
      },
    });
    await trace(guest.created, 'AWAITING_PAYMENT');
    await cancel(guest.created, 200);
    await cancel(guest.created, 200);
    const cancelled = await trace(guest.created, 'CANCELLED');
    assert.deepEqual(
      cancelled.body.events.map(
        (event: { toStatus: string }) => event.toStatus,
      ),
      ['AWAITING_PAYMENT', 'CANCELLED'],
    );
    assert.equal((await state(guest.created.order.id)).payments.length, 0);
    await post(
      cashPath(guest.created.order.id),
      cashBody(guest.created),
      409,
      manager,
    );
    const customerCancellation = await mint(customer);
    await cancel(customerCancellation.created, 200, customer);
    await cancel(customerCancellation.created, 200, customer);
    const mine = await get('/orders/mine?page=1&limit=1', 200, customer);
    assert.equal(mine.body.orders.length, 1);
    assert(mine.body.pagination.total >= 2);
    const managerAnalytics = await get(
      `/manager/stations/${station.id}/analytics`,
      200,
      manager,
    );
    const groups = await prisma.fuelOrder.groupBy({
      by: ['status'],
      where: { stationId: station.id },
      _count: { _all: true },
    });
    for (const group of groups)
      assert.equal(
        managerAnalytics.body.orders.countsByStatus[group.status],
        group._count._all,
      );
    console.info(`PASS: ${phase}`);

    phase = 'real concurrent pump reservations and database unique enforcement';
    const left = await mint();
    const right = await mint();
    const reservations = await Promise.all([
      confirmRequest(left.created),
      confirmRequest(right.created),
    ]);
    assert.deepEqual(
      reservations.map((response) => response.status).sort(),
      [201, 409],
    );
    const winner = reservations[0].status === 201 ? left : right;
    const loser = reservations[0].status === 201 ? right : left;
    assert.equal((await state(loser.created.order.id)).payments.length, 0);
    await assert.rejects(
      prisma.fuelOrder.update({
        where: { id: loser.created.order.id },
        data: { pumpId: pump.id, status: 'PENDING' },
      }),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'P2002',
    );
    await post(
      `/employee/orders/${winner.created.order.id}/claim`,
      {},
      200,
      employee,
    );
    await post(
      cashPath(loser.created.order.id),
      cashBody(loser.created),
      409,
      manager,
    );
    await post(
      `/employee/orders/${winner.created.order.id}/complete`,
      {},
      200,
      employee,
    );
    await post(
      cashPath(loser.created.order.id),
      cashBody(loser.created),
      201,
      manager,
    );
    await post(
      cashPath(winner.created.order.id),
      cashBody(winner.created),
      200,
      manager,
    );
    assert.equal(
      await prisma.fuelOrder.count({
        where: { pumpId: pump.id, status: { in: ['PENDING', 'IN_PROGRESS'] } },
      }),
      1,
    );
    await post(
      `/employee/orders/${loser.created.order.id}/claim`,
      {},
      200,
      employee,
    );
    await post(
      `/employee/orders/${loser.created.order.id}/complete`,
      {},
      200,
      employee,
    );
    console.info(`PASS: ${phase}`);

    phase = 'real cancellation/payment races in both lock orders';
    for (const cancellationFirst of [true, false]) {
      const target = await mint(customer);
      const cashLock = cashOrdersRepository.lockOrder;
      const cancelLock = orderCancellationRepository.lockOrder;
      let locked!: () => void;
      let arrived!: () => void;
      const held = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const competitor = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      const wait = async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            competitor,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error('Lock barrier timed out')),
                2000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };
      cashOrdersRepository.lockOrder = async (...args) => {
        if (args[0] !== target.created.order.id) return cashLock(...args);
        if (cancellationFirst) {
          arrived();
          return cashLock(...args);
        }
        const result = await cashLock(...args);
        locked();
        await wait();
        return result;
      };
      orderCancellationRepository.lockOrder = async (...args) => {
        if (args[0] !== target.created.order.id) return cancelLock(...args);
        if (!cancellationFirst) {
          arrived();
          return cancelLock(...args);
        }
        const result = await cancelLock(...args);
        locked();
        await wait();
        return result;
      };
      try {
        const first = cancellationFirst
          ? cancel(target.created, 200, customer)
          : post(
              cashPath(target.created.order.id),
              cashBody(target.created),
              201,
              manager,
            );
        const firstOutcome = Promise.allSettled([first]);
        await Promise.race([
          held,
          first.then(() => {
            throw new Error('Expected order lock');
          }),
        ]);
        const second = cancellationFirst
          ? post(
              cashPath(target.created.order.id),
              cashBody(target.created),
              409,
              manager,
            )
          : cancel(target.created, 409, customer);
        const results = await Promise.all([
          firstOutcome,
          Promise.allSettled([second]),
        ]);
        assert(results.flat().every((result) => result.status === 'fulfilled'));
      } finally {
        arrived();
        cashOrdersRepository.lockOrder = cashLock;
        orderCancellationRepository.lockOrder = cancelLock;
      }
      const current = await state(target.created.order.id);
      assert.equal(current.status, cancellationFirst ? 'CANCELLED' : 'PENDING');
      assert.equal(current.payments.length, cancellationFirst ? 0 : 1);
      assert.equal(current.events.length, 2);
      if (!cancellationFirst) {
        await post(
          `/employee/orders/${target.created.order.id}/claim`,
          {},
          200,
          employee,
        );
        await post(
          `/employee/orders/${target.created.order.id}/complete`,
          {},
          200,
          employee,
        );
      }
    }
    const double = await mint(customer);
    const duplicateCancels = await Promise.all([
      cancel(double.created, 200, customer),
      cancel(double.created, 200, customer),
    ]);
    assert.deepEqual(
      duplicateCancels.map((response) => response.body.replayed).sort(),
      [false, true],
    );
    assert.equal((await state(double.created.order.id)).events.length, 2);
    console.info(`PASS: ${phase}`);

    phase =
      'actual event FK failures roll back payment, reservation and cancellation';
    assert.equal(
      await prisma.user.findUnique({ where: { id: -2147483648 } }),
      null,
    );
    const originalWriteTransaction = employeeOrdersRepository.writeTransaction;
    for (const operation of ['cash', 'cancel', 'complete'] as const) {
      const target = await mint(customer);
      if (operation === 'complete') {
        await post(
          cashPath(target.created.order.id),
          cashBody(target.created),
          201,
          manager,
        );
        await post(
          `/employee/orders/${target.created.order.id}/claim`,
          {},
          200,
          employee,
        );
      }
      const snapshot = await state(target.created.order.id);
      let injected = false;
      // Root Prisma delegates are different from interactive-transaction delegates.
      // Inject into the actual transaction without altering application behavior.
      employeeOrdersRepository.writeTransaction = (work) =>
        originalWriteTransaction(async (tx) =>
          work(
            new Proxy(tx, {
              get(target, property) {
                if (property !== 'orderEvent')
                  return Reflect.get(target, property);
                return new Proxy(target.orderEvent, {
                  get(delegate, key) {
                    if (key !== 'create') return Reflect.get(delegate, key);
                    return async (args: Prisma.OrderEventCreateArgs) => {
                      injected = true;
                      try {
                        return await tx.orderEvent.create({
                          ...args,
                          data: {
                            ...(args.data as Prisma.OrderEventUncheckedCreateInput),
                            actorUserId: -2147483648,
                          },
                        });
                      } catch (error) {
                        const failure = error as {
                          code?: string;
                          meta?: {
                            driverAdapterError?: {
                              cause?: { originalCode?: string };
                            };
                          };
                        };
                        console.info(
                          JSON.stringify({
                            operation,
                            injectedEventFailure: failure.code,
                            sqlState:
                              failure.meta?.driverAdapterError?.cause
                                ?.originalCode,
                          }),
                        );
                        throw error;
                      }
                    };
                  },
                });
              },
            }),
          ),
        );
      try {
        if (operation === 'cash')
          await post(
            cashPath(target.created.order.id),
            cashBody(target.created),
            409,
            manager,
          );
        else if (operation === 'cancel')
          await cancel(target.created, 409, customer);
        else
          await post(
            `/employee/orders/${target.created.order.id}/complete`,
            {},
            409,
            employee,
          );
      } finally {
        employeeOrdersRepository.writeTransaction = originalWriteTransaction;
      }
      assert(injected, 'Event FK failure must execute inside the transaction');
      assert.deepEqual(await state(target.created.order.id), snapshot);
      if (operation === 'complete') {
        const waiting = await mint();
        await post(
          cashPath(waiting.created.order.id),
          cashBody(waiting.created),
          409,
          manager,
        );
        await post(
          `/employee/orders/${target.created.order.id}/complete`,
          {},
          200,
          employee,
        );
      } else await cancel(target.created, 200, customer);
    }
    console.info(`PASS: ${phase}`);
    phase =
      'Task 02 station deactivation versus creation, cash and paid claims in both lock orders';
    const { orderCreationService, cashOrdersService, employeeOrdersService } =
      await import('../src/modules/orders/orders.service.js');
    const { stationsService } =
      await import('../src/modules/stations/stations.service.js');
    const { stationsRepository } =
      await import('../src/modules/stations/stations.repository.js');
    const conflict = (outcome: PromiseSettledResult<unknown>) => {
      assert(outcome.status === 'rejected');
      assert.equal(outcome.reason.statusCode, 409);
    };
    for (const operation of ['create', 'cash', 'claim'] as const) {
      for (const workFirst of [true, false]) {
        // Isolate these cases from all retained earlier work; never clean up
        // existing paid orders just to make a station status test pass.
        const isolatedManager = await person(managerRole.id, 'MANAGER');
        const isolated = await prisma.station.create({
          data: {
            name: `Operational race ${run} ${operation} ${workFirst}`,
            managerId: isolatedManager.id,
          },
        });
        const reservedPump = await prisma.pump.create({
          data: { stationId: isolated.id, number: 1, status: 'IDLE' },
        });
        const worker = await person(employeeRole.id, 'EMPLOYEE', isolated.id);
        const quotation = await orderCreationService.quote(undefined, {
          stationId: isolated.id,
          fuelTypeId: fuel.id,
          currency: 'USD',
          fulfillmentType: 'IN_STATION',
          inputMode: 'LITERS',
          value: '1.250',
        });
        const input = {
          quoteId: quotation.quote.id,
          guestToken: quotation.guestToken,
          idempotencyKey: randomUUID(),
        };
        const created =
          operation === 'create'
            ? null
            : await orderCreationService.create(undefined, input);
        const confirmation = {
          amountMinor: quotation.quote.totalMinor,
          currency: 'USD' as const,
          pumpId: reservedPump.id,
        };
        if (operation === 'claim')
          await cashOrdersService.confirm(
            isolatedManager,
            isolated.id,
            created!.order.id,
            confirmation,
          );
        const before = created ? await state(created.order.id) : null;

        const originalStatusLock = stationsRepository.lockStation;
        const originalCashLock = cashOrdersRepository.lockStation;
        const originalWorkLock = employeeOrdersRepository.lockStation;
        let firstLocked!: () => void;
        let competitorArrived!: () => void;
        const held = new Promise<void>((resolve) => {
          firstLocked = resolve;
        });
        const arrived = new Promise<void>((resolve) => {
          competitorArrived = resolve;
        });
        let waiting = true;
        const gate = async <T>(first: boolean, acquire: () => Promise<T>) => {
          if (first && waiting) {
            waiting = false;
            const result = await acquire();
            firstLocked();
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([
                arrived,
                new Promise<never>((_, reject) => {
                  timer = setTimeout(
                    () => reject(new Error('Station race barrier timed out')),
                    2000,
                  );
                }),
              ]);
            } finally {
              clearTimeout(timer);
            }
            return result;
          }
          competitorArrived();
          return acquire();
        };
        stationsRepository.lockStation = (id, tx) =>
          id === isolated.id
            ? gate(!workFirst, () => originalStatusLock(id, tx))
            : originalStatusLock(id, tx);
        cashOrdersRepository.lockStation = (id, tx) =>
          id === isolated.id
            ? gate(workFirst, () => originalCashLock(id, tx))
            : originalCashLock(id, tx);
        employeeOrdersRepository.lockStation = (id, tx) =>
          id === isolated.id
            ? gate(workFirst, () => originalWorkLock(id, tx))
            : originalWorkLock(id, tx);
        const work = () =>
          operation === 'create'
            ? orderCreationService.create(undefined, input)
            : operation === 'cash'
              ? cashOrdersService.confirm(
                  isolatedManager,
                  isolated.id,
                  created!.order.id,
                  confirmation,
                )
              : employeeOrdersService.transition(
                  worker,
                  created!.order.id,
                  'claim',
                );
        const deactivate = () => stationsService.setStatus(isolated.id, false);
        try {
          const first = workFirst ? work() : deactivate();
          const firstResult = Promise.allSettled([first]);
          await Promise.race([
            held,
            first.then(() => {
              throw new Error('Expected station lock barrier');
            }),
          ]);
          const secondResult = Promise.allSettled([
            workFirst ? deactivate() : work(),
          ]);
          const [one, two] = await Promise.all([firstResult, secondResult]);
          const [workResult, statusResult] = workFirst
            ? [one[0], two[0]]
            : [two[0], one[0]];
          if (operation === 'claim' || workFirst)
            assert.equal(workResult.status, 'fulfilled');
          else conflict(workResult);
          if (operation === 'claim' || (operation === 'cash' && workFirst))
            conflict(statusResult);
          else assert.equal(statusResult.status, 'fulfilled');
        } finally {
          competitorArrived();
          stationsRepository.lockStation = originalStatusLock;
          cashOrdersRepository.lockStation = originalCashLock;
          employeeOrdersRepository.lockStation = originalWorkLock;
        }
        const active = (
          await prisma.station.findUniqueOrThrow({ where: { id: isolated.id } })
        ).isActive;
        assert.equal(
          active,
          operation === 'claim' || (operation === 'cash' && workFirst),
        );
        if (operation === 'create') {
          const rows = await prisma.fuelOrder.findMany({
            where: { quoteId: input.quoteId },
            include: { payments: true },
          });
          assert.equal(rows.length, workFirst ? 1 : 0);
          if (rows.length) {
            assert.equal(rows[0].status, 'AWAITING_PAYMENT');
            assert.equal(rows[0].payments.length, 0);
          }
        } else {
          const saved = await state(created!.order.id);
          assert.equal(
            saved.status,
            operation === 'claim'
              ? 'IN_PROGRESS'
              : workFirst
                ? 'PENDING'
                : 'AWAITING_PAYMENT',
          );
          assert.equal(saved.payments.length, active ? 1 : 0);
          assert.equal(saved.pumpId, active ? reservedPump.id : null);
          if (operation === 'claim')
            assert.deepEqual(saved.payments, before!.payments);
          if (active) {
            // Rejected deactivation must not change timestamps, events, payment,
            // reservation, worker assignments or station relationships.
            const stationBefore = await prisma.station.findUniqueOrThrow({
              where: { id: isolated.id },
            });
            await assert.rejects(
              deactivate(),
              (error: unknown) =>
                (error as { statusCode: number }).statusCode === 409,
            );
            assert.deepEqual(await state(saved.id), saved);
            assert.deepEqual(
              await prisma.station.findUniqueOrThrow({
                where: { id: isolated.id },
              }),
              stationBefore,
            );
            if (operation === 'cash')
              await employeeOrdersService.transition(worker, saved.id, 'claim');
            await employeeOrdersService.transition(
              worker,
              saved.id,
              'complete',
            );
            const historical = await state(saved.id);
            await deactivate();
            assert.deepEqual(await state(saved.id), historical);
          }
        }
        const version = () =>
          prisma.$queryRaw<
            { version: string }[]
          >`SELECT xmin::text AS version FROM stations WHERE id = ${isolated.id}`;
        const inactive = await version();
        await deactivate();
        assert.deepEqual(await version(), inactive);
      }
    }
    console.info(`PASS: ${phase}`);
  } catch (error) {
    console.error(`FAIL scenario: ${phase}`);
    throw error;
  } finally {
    cashOrdersRepository.lockOrder = originalLockOrder;
    errorLayer.handle = errorHandler;
    await prisma.$disconnect();
  }
}
