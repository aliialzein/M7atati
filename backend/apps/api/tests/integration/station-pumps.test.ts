import request from 'supertest';
import { app } from '../../src/app.js';
import { prisma } from '../../src/database/prisma.js';
import { tokenService } from '../../src/modules/auth/token.service.js';

jest.mock('../../src/database/prisma.js', () => ({
  prisma: {
    user: { findUnique: jest.fn() },
    station: { findFirst: jest.fn(), update: jest.fn() },
    pump: { update: jest.fn() },
    fuelOrder: { updateMany: jest.fn() },
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
  },
}));
jest.mock('../../src/utils/logger.js', () => ({
  logger: { error: jest.fn() },
}));
const db = prisma as unknown as {
  user: { findUnique: jest.Mock };
  station: { findFirst: jest.Mock; update: jest.Mock };
  pump: { update: jest.Mock };
  fuelOrder: { updateMany: jest.Mock };
  $transaction: jest.Mock;
  $queryRaw: jest.Mock;
};
let role: string;
let permissions: string[];
function lookup(path = '10', authenticated = true) {
  const call = request(app).get(`/api/stations/${path}/pumps`);
  if (authenticated)
    call.set('Cookie', `m7atati_access=${tokenService.issue(1).accessToken}`);
  return call;
}
beforeEach(() => {
  jest.resetAllMocks();
  role = 'MANAGER';
  permissions = ['payments.manage'];
  db.user.findUnique.mockImplementation(async () => ({
    id: 1,
    name: 'Staff',
    email: 'staff@example.invalid',
    isActive: true,
    tokenVersion: 0,
    stationId: null,
    role: {
      name: role,
      permissions: permissions.map((key) => ({ permission: { key } })),
    },
  }));
  db.$transaction.mockImplementation((work) => work(db));
  db.station.findFirst.mockResolvedValue({ id: 10, isActive: true, pumps: [] });
});

describe('station-scoped pump lookup (mocked Prisma)', () => {
  it('selects scoped pumps with deterministic ordering and filtered reservation counts', async () => {
    db.station.findFirst.mockResolvedValue({
      id: 10,
      isActive: true,
      pumps: [
        { id: 7, number: 1, status: 'IDLE', _count: { orders: 0 } },
        { id: 3, number: 2, status: 'IDLE', _count: { orders: 1 } },
      ],
    });
    const response = await lookup();
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({
      pumps: [
        { id: 7, number: 1, status: 'IDLE', available: true },
        { id: 3, number: 2, status: 'IDLE', available: false },
      ],
    });
    expect(db.station.findFirst).toHaveBeenCalledWith({
      where: { AND: [{ id: 10 }, { managerId: 1 }] },
      select: {
        id: true,
        isActive: true,
        pumps: {
          orderBy: [{ number: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            number: true,
            status: true,
            _count: {
              select: {
                orders: {
                  where: { status: { in: ['PENDING', 'IN_PROGRESS'] } },
                },
              },
            },
          },
        },
      },
    });
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    });
    expect(db.station.update).not.toHaveBeenCalled();
    expect(db.pump.update).not.toHaveBeenCalled();
    expect(db.fuelOrder.updateMany).not.toHaveBeenCalled();
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });
  it('returns an empty array for an active station with no pumps', async () => {
    expect((await lookup()).body).toEqual({ pumps: [] });
  });
  it.each(['OFFLINE', 'BUSY', 'DISPENSING', 'unknown', 'idle'])(
    'fails closed for pump status %s',
    async (status) => {
      db.station.findFirst.mockResolvedValue({
        id: 10,
        isActive: true,
        pumps: [
          {
            id: 7,
            number: 1,
            status,
            _count: { orders: 0 },
            orders: [{ customerName: 'private' }],
            stationId: 10,
          },
        ],
      });
      expect((await lookup()).body).toEqual({
        pumps: [{ id: 7, number: 1, status, available: false }],
      });
    },
  );
  it.each(['0', '-1', '1.2', 'abc', '2147483648'])(
    'rejects malformed station ID %s',
    async (id) => {
      expect((await lookup(id)).status).toBe(400);
      expect(db.station.findFirst).not.toHaveBeenCalled();
    },
  );
  it('rejects unsupported filters without touching station data', async () => {
    const response = await request(app)
      .get('/api/stations/10/pumps?available=true')
      .set('Cookie', `m7atati_access=${tokenService.issue(1).accessToken}`);
    expect(response.status).toBe(400);
    expect(db.station.findFirst).not.toHaveBeenCalled();
  });
  it('returns the same 404 for nonexistent or unmanaged stations', async () => {
    db.station.findFirst.mockResolvedValue(null);
    expect((await lookup()).body).toEqual({ message: 'Station not found' });
    expect((await lookup('11')).status).toBe(404);
  });
  it('returns 409 for an owned inactive station, exposing no pumps', async () => {
    db.station.findFirst.mockResolvedValue({
      id: 10,
      isActive: false,
      pumps: [],
    });
    const response = await lookup();
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ message: 'Station is inactive' });
  });
  it('requires authentication', async () => {
    expect((await lookup('10', false)).status).toBe(401);
    expect(db.station.findFirst).not.toHaveBeenCalled();
  });
  it.each(['EMPLOYEE', 'CUSTOMER', 'HR', 'SECURITY'])(
    'rejects role %s even with both permissions',
    async (denied) => {
      role = denied;
      permissions = ['payments.manage', 'stations.read'];
      expect((await lookup()).status).toBe(403);
      expect(db.station.findFirst).not.toHaveBeenCalled();
    },
  );
  it.each(['ADMIN', 'MANAGER'])(
    'requires the existing permission for %s',
    async (allowed) => {
      role = allowed;
      permissions = [];
      expect((await lookup()).status).toBe(403);
      expect(db.station.findFirst).not.toHaveBeenCalled();
    },
  );
  it('allows ADMIN station readers without manager ownership', async () => {
    role = 'ADMIN';
    permissions = ['stations.read'];
    expect((await lookup()).status).toBe(200);
    expect(db.station.findFirst.mock.calls[0][0].where).toEqual({
      AND: [{ id: 10 }, {}],
    });
  });
  it('sanitizes persistence failures', async () => {
    db.station.findFirst.mockRejectedValue(new Error('Internal diagnostic'));
    const response = await lookup();
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ message: 'Internal Server Error' });
  });
});
