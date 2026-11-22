import type { Prisma } from '../../src/generated/prisma/client.js';
import { Decimal } from '@prisma/client/runtime/client';
import { employeeOrdersService } from '../../src/modules/orders/orders.service.js';
import { employeeOrdersRepository } from '../../src/modules/orders/orders.repository.js';
import { stationsService } from '../../src/modules/stations/stations.service.js';
import { stationsRepository } from '../../src/modules/stations/stations.repository.js';
import { HttpError } from '../../src/types/http-error.js';

jest.mock('../../src/database/prisma.js', () => ({ prisma: {} }));

// Services await these results; doubles do not implement Prisma's optional
// lazy relation accessors. Keep the relaxed return types at this test boundary.
type AwaitedMethods<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : T[K];
};
const orderMocks = employeeOrdersRepository as unknown as AwaitedMethods<
  typeof employeeOrdersRepository
>;
const stationMocks = stationsRepository as unknown as AwaitedMethods<
  typeof stationsRepository
>;

afterEach(() => jest.restoreAllMocks());

// Service protocol regression only: model incompatible station locks, without
// pretending to emulate PostgreSQL snapshots, deadlocks or serialization retries.
it.each([true, false])(
  'preserves station/order consistency when claim acquires the station lock first: %s',
  async (claimFirst) => {
    let active = true;
    let status = 'PENDING';
    let assignee: number | null = null;
    const events: { fromStatus: string; toStatus: string }[] = [];
    const releases = new Map<Prisma.TransactionClient, () => void>();
    let tail = Promise.resolve();
    const acquire = async (tx: Prisma.TransactionClient) => {
      const previous = tail;
      tail = new Promise<void>((resolve) => releases.set(tx, resolve));
      await previous;
    };
    async function transaction<T>(
      work: (tx: Prisma.TransactionClient) => Promise<T>,
    ) {
      const tx = {} as Prisma.TransactionClient;
      try {
        return await work(tx);
      } finally {
        releases.get(tx)?.();
      }
    }
    let firstLocked!: () => void;
    let competitorArrived!: () => void;
    const locked = new Promise<void>((resolve) => {
      firstLocked = resolve;
    });
    const arrived = new Promise<void>((resolve) => {
      competitorArrived = resolve;
    });
    const stationLock = async (
      first: boolean,
      tx: Prisma.TransactionClient,
    ) => {
      if (first) {
        await acquire(tx);
        firstLocked();
        await arrived;
      } else {
        competitorArrived();
        await acquire(tx);
      }
    };
    jest
      .spyOn(employeeOrdersRepository, 'writeTransaction')
      .mockImplementation(transaction);
    jest
      .spyOn(stationsRepository, 'transaction')
      .mockImplementation(transaction);
    jest.spyOn(employeeOrdersRepository, 'lockEmployee').mockResolvedValue();
    jest.spyOn(orderMocks, 'employee').mockImplementation(async () => ({
      id: 3,
      isActive: true,
      stationId: 10,
      // Deliberately stale: only the locked station check is authoritative.
      station: { id: 10, isActive: true },
      role: {
        name: 'EMPLOYEE',
        permissions: [{ permission: { key: 'orders.update' } }],
      },
    }));
    jest
      .spyOn(employeeOrdersRepository, 'lockStation')
      .mockImplementation(async (_id, tx) => {
        await stationLock(claimFirst, tx);
        return { id: 10, isActive: active };
      });
    jest
      .spyOn(stationsRepository, 'lockStation')
      .mockImplementation(async (_id, tx) => {
        await stationLock(!claimFirst, tx);
      });
    const station = () => ({
      id: 10,
      name: 'Station',
      address: null,
      latitude: null,
      longitude: null,
      isActive: active,
      managerId: null,
      createdAt: new Date(0),
    });
    jest.spyOn(stationMocks, 'find').mockImplementation(async () => station());
    jest
      .spyOn(stationsRepository, 'hasInProgressOrder')
      .mockImplementation(async () => status === 'IN_PROGRESS');
    jest
      .spyOn(stationMocks, 'update')
      .mockImplementation(async (_id, input) => {
        if ('isActive' in input) active = input.isActive;
        return station();
      });
    jest.spyOn(orderMocks, 'detail').mockImplementation(async () => ({
      id: 1,
      stationId: 10,
      status,
      assignedEmployeeId: assignee,
      claimedAt: assignee === null ? null : new Date(0),
      createdAt: new Date(0),
      updatedAt: new Date(0),
      orderedVolume: new Decimal('25'),
      pump: { id: 1, number: 1 },
      fuelType: { id: 1, code: 'TEST', name: 'Test fuel' },
      events: events.map((event, index) => ({
        ...event,
        id: index + 1,
        actorUserId: 3,
        actorType: 'EMPLOYEE',
        createdAt: new Date(0),
      })),
    }));
    jest
      .spyOn(orderMocks, 'claim')
      .mockImplementation(async (_id, _station, employeeId) => {
        if (status !== 'PENDING' || assignee !== null) return { count: 0 };
        status = 'IN_PROGRESS';
        assignee = employeeId;
        return { count: 1 };
      });
    jest
      .spyOn(orderMocks, 'event')
      .mockImplementation(async (id, employeeId, fromStatus, toStatus) => {
        events.push({ fromStatus, toStatus });
        return {
          id: events.length,
          orderId: id,
          actorUserId: employeeId,
          actorType: 'EMPLOYEE',
          fromStatus,
          toStatus,
          note: null,
          createdAt: new Date(0),
        };
      });
    const claim = () =>
      employeeOrdersService.transition(
        {
          id: 3,
          role: 'EMPLOYEE',
          name: 'Employee',
          email: 'employee@example.invalid',
          stationId: 10,
        },
        1,
        'claim',
      );
    const deactivate = () => stationsService.setStatus(10, false);
    const first = claimFirst ? claim() : deactivate();
    const one = Promise.allSettled([first]);
    try {
      await Promise.race([
        locked,
        first.then(() => {
          throw new Error('Expected lock barrier');
        }),
      ]);
      const two = Promise.allSettled([claimFirst ? deactivate() : claim()]);
      const [firstResults, secondResults] = await Promise.all([one, two]);
      expect(firstResults[0].status).toBe('fulfilled');
      expect(secondResults[0].status).toBe('rejected');
      if (secondResults[0].status === 'rejected') {
        expect(secondResults[0].reason).toBeInstanceOf(HttpError);
        expect(secondResults[0].reason.statusCode).toBe(409);
      }
      expect(active).toBe(claimFirst);
      expect(status).toBe(claimFirst ? 'IN_PROGRESS' : 'PENDING');
      expect(assignee).toBe(claimFirst ? 3 : null);
      expect(events).toEqual(
        claimFirst ? [{ fromStatus: 'PENDING', toStatus: 'IN_PROGRESS' }] : [],
      );
    } finally {
      competitorArrived();
      await one;
    }
  },
);
