import { EventEmitter } from 'node:events';

const mockPrisma = {
  $connect: jest.fn(),
  $queryRaw: jest.fn(),
  $disconnect: jest.fn(),
};
const mockServer = Object.assign(new EventEmitter(), {
  listening: true,
  close: jest.fn((callback: (error?: Error) => void) => callback()),
});
const mockListen = jest.fn(() => {
  process.nextTick(() => mockServer.emit('listening'));
  return mockServer;
});

jest.mock('../../src/config/env.js', () => ({ env: { port: 4000 } }));
jest.mock('../../src/database/prisma.js', () => ({ prisma: mockPrisma }));
jest.mock('../../src/app.js', () => ({ app: { listen: mockListen } }));
jest.mock('../../src/utils/logger.js', () => ({
  logger: { info: jest.fn(), error: jest.fn() },
}));

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('server lifecycle', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockServer.removeAllListeners();
    mockPrisma.$connect.mockResolvedValue(undefined);
    mockPrisma.$queryRaw.mockResolvedValue([]);
    mockPrisma.$disconnect.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.exitCode = 0;
  });

  it('verifies the database before listening and shuts down only once', async () => {
    const signals = new Map<string | symbol, () => void>();
    jest.spyOn(process, 'on').mockImplementation((event, listener) => {
      signals.set(event, listener as () => void);
      return process;
    });
    await import('../../src/server.js');
    await settle();

    expect(mockPrisma.$connect).toHaveBeenCalledTimes(1);
    expect(mockPrisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mockListen.mock.invocationCallOrder[0],
    );

    signals.get('SIGTERM')!();
    signals.get('SIGINT')!();
    await settle();

    expect(mockServer.close).toHaveBeenCalledTimes(1);
    expect(mockPrisma.$disconnect).toHaveBeenCalledTimes(1);
    expect(mockServer.close.mock.invocationCallOrder[0]).toBeLessThan(
      mockPrisma.$disconnect.mock.invocationCallOrder[0],
    );
  });

  it('does not listen when the database query fails', async () => {
    mockPrisma.$queryRaw.mockRejectedValue(new Error('private database error'));
    await import('../../src/server.js');
    await settle();

    expect(mockListen).not.toHaveBeenCalled();
    expect(mockPrisma.$disconnect).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });
});
