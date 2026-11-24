import request from 'supertest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { app } from '../../src/app.js';
import { prisma } from '../../src/database/prisma.js';
import { ACCESS_COOKIE } from '../../src/modules/auth/auth.types.js';
import { tokenService } from '../../src/modules/auth/token.service.js';
import { workRecordFixtures } from '../fixtures/attendance.js';
import { ATTENDANCE_EXPORT_LIMIT } from '../../src/modules/attendance/attendance.service.js';

jest.mock('../../src/database/prisma.js', () => ({
  prisma: {
    user: { findUnique: jest.fn() },
    station: { findMany: jest.fn(), findFirst: jest.fn() },
    attendanceRecord: { findMany: jest.fn(), count: jest.fn() },
    $transaction: jest.fn(),
  },
}));
jest.mock('../../src/utils/logger.js', () => ({
  logger: { error: jest.fn() },
}));

const db = prisma as unknown as {
  user: { findUnique: jest.Mock };
  station: { findMany: jest.Mock; findFirst: jest.Mock };
  attendanceRecord: { findMany: jest.Mock; count: jest.Mock };
  $transaction: jest.Mock;
};
type Station = {
  id: number;
  name: string;
  isActive: boolean;
  managerId: number | null;
};
type Row = {
  id: number;
  stationId: number;
  employeeId: number;
  clockInAt: Date;
  clockOutAt: Date | null;
  createdAt: Date;
};
type Where = { OR?: Where[]; [key: string]: unknown };
let stations: Station[];
let rows: Row[];
let role: string;
let permissions: string[];
let employeeName: string;
const base = '/api/manager/stations/10/attendance';
const paths = [base, `${base}/export?format=csv`, `${base}/export?format=pdf`];

function get(
  path: string,
  query: Record<string, string | number | undefined> = {},
  authenticated = true,
  actorId = 1,
) {
  const pending = request(app).get(path).query(query);
  if (authenticated)
    pending.set(
      'Cookie',
      `${ACCESS_COOKIE}=${tokenService.issue(actorId).accessToken}`,
    );
  return pending;
}

function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'OR')
      return (value as Where[]).some((part) => matches(row, part));
    const actual = row[key as keyof Row];
    if (value !== null && typeof value === 'object') {
      const compare = value as { lt?: Date; gt?: Date };
      return (
        actual instanceof Date &&
        (!compare.lt || actual < compare.lt) &&
        (!compare.gt || actual > compare.gt)
      );
    }
    return actual === value;
  });
}

function pdfPages(buffer: Buffer): string[] {
  expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
  const parsed = spawnSync(
    process.execPath,
    [join(__dirname, '../helpers/read-pdf.mjs')],
    {
      input: buffer,
      encoding: 'utf8',
      maxBuffer: 5 * 1024 * 1024,
    },
  );
  expect(parsed.stderr).toBe('');
  expect(parsed.status).toBe(0);
  return JSON.parse(parsed.stdout);
}

beforeEach(() => {
  jest.resetAllMocks();
  role = 'MANAGER';
  permissions = ['attendance.read'];
  employeeName = 'Transferred Zoë';
  stations = [
    { id: 10, name: 'Historical Café', isActive: false, managerId: 1 },
    { id: 11, name: 'Active North', isActive: true, managerId: null },
    { id: 20, name: 'Affiliated only', isActive: true, managerId: 2 },
  ];
  rows = workRecordFixtures({
    employeeA: 3,
    employeeB: 4,
    stationA: 10,
    stationB: 20,
  }).attendance.map((row, i) => ({
    ...row,
    id: i + 1,
    createdAt: new Date('2026-11-19T12:00:00Z'),
  }));
  db.user.findUnique.mockImplementation(async ({ where }) => ({
    id: where.id,
    name: 'Manager',
    email: 'manager@example.invalid',
    isActive: true,
    tokenVersion: 0,
    stationId: 20,
    role: {
      name: role,
      permissions: permissions.map((key) => ({ permission: { key } })),
    },
  }));
  db.$transaction.mockImplementation(
    async (work: (tx: typeof db) => Promise<unknown>) => work(db),
  );
  db.station.findMany.mockImplementation(
    async ({ where }: { where: { managerId: number } }) =>
      stations
        .filter((s) => s.managerId === where.managerId)
        .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id),
  );
  db.station.findFirst.mockImplementation(
    async ({
      where,
    }: {
      where: { AND: [{ id: number }, { managerId: number }] };
    }) =>
      stations.find(
        (s) =>
          s.id === where.AND[0].id && s.managerId === where.AND[1].managerId,
      ) ?? null,
  );
  db.attendanceRecord.count.mockImplementation(
    async ({ where }: { where: Where }) =>
      rows.filter((row) => matches(row, where)).length,
  );
  db.attendanceRecord.findMany.mockImplementation(
    async ({
      where,
      skip = 0,
      take,
    }: {
      where: Where;
      skip?: number;
      take: number;
    }) =>
      rows
        .filter((row) => matches(row, where))
        .sort(
          (a, b) => Number(a.clockInAt) - Number(b.clockInAt) || a.id - b.id,
        )
        .slice(skip, skip + take)
        .map((row) => ({
          ...row,
          employee: {
            id: row.employeeId,
            name: `${employeeName} ${row.id}`,
            isActive: false,
          },
          station: stations.find((s) => s.id === row.stationId),
        })),
  );
});

describe('managed station discovery', () => {
  it('revokes discovery, attendance and export access immediately after reassignment and grants it to the new owner', async () => {
    stations[2].managerId = null;
    stations[0].managerId = 2;
    expect((await get('/api/stations/managed')).body.stations).toEqual([]);
    expect(
      (await get('/api/stations/managed', {}, true, 2)).body.stations,
    ).toEqual([{ id: 10, name: stations[0].name, isActive: false }]);
    for (const path of paths) {
      expect((await get(path)).status).toBe(404);
      expect((await get(path, {}, true, 2)).status).toBe(200);
    }
  });
  it('returns the single owned station, including inactive, with only minimal fields', async () => {
    permissions = []; // Discovery requires the role, not stations.read or attendance.read.
    const response = await get('/api/stations/managed');
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({
      stations: [{ id: 10, name: 'Historical Café', isActive: false }],
    });
    expect(db.station.findMany).toHaveBeenCalledWith({
      where: { managerId: 1 },
      select: { id: true, name: true, isActive: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  });
  it('returns an empty list for a manager without stations', async () => {
    stations.forEach((s) => {
      s.managerId = null;
    });
    expect((await get('/api/stations/managed')).body).toEqual({ stations: [] });
  });
});

describe('manager endpoint access', () => {
  it.each(['/api/stations/managed', ...paths])(
    'requires authentication: %s',
    async (path) => {
      expect((await get(path, {}, false)).status).toBe(401);
      expect(db.station.findFirst).not.toHaveBeenCalled();
      expect(db.station.findMany).not.toHaveBeenCalled();
    },
  );
  it.each(['ADMIN', 'HR', 'EMPLOYEE', 'SECURITY', 'CUSTOMER'])(
    'rejects %s even with permissions',
    async (value) => {
      role = value;
      for (const path of ['/api/stations/managed', ...paths])
        expect((await get(path)).status).toBe(403);
      expect(db.$transaction).not.toHaveBeenCalled();
    },
  );
  it.each(paths)('requires attendance.read: %s', async (path) => {
    permissions = ['reports.read', 'shifts.read'];
    expect((await get(path)).status).toBe(403);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it.each(paths)(
    'uses the same 404 for unmanaged and unknown stations: %s',
    async (path) => {
      for (const id of [20, 999]) {
        const response = await get(path.replace('/10/', `/${id}/`));
        expect(response.status).toBe(404);
        expect(response.body).toEqual({ message: 'Station not found' });
        expect(response.headers['cache-control']).toBe('no-store');
      }
      expect(db.attendanceRecord.findMany).not.toHaveBeenCalled();
      expect(db.attendanceRecord.count).not.toHaveBeenCalled();
    },
  );
  it('does not unlock manager shifts or existing global attendance/stations', async () => {
    for (const path of [
      '/api/shifts',
      '/api/attendance',
      '/api/stations',
      '/api/stations/10',
    ])
      expect((await get(path)).status).toBe(403);
  });
});

describe('manager attendance list and filters', () => {
  it('filters stored station before rows/count/pagination and preserves transferred/inactive history', async () => {
    const response = await get(base, { limit: 1, page: 2 });
    expect(response.status).toBe(200);
    expect(response.body.pagination).toEqual({
      page: 2,
      limit: 1,
      total: 4,
      totalPages: 4,
    });
    expect(response.body.attendance.map((r: Row) => r.id)).toEqual([1]);
    expect(response.body.attendance[0].employee.isActive).toBe(false);
    expect(response.body.attendance[0].station.isActive).toBe(false);
    expect(db.station.findFirst.mock.calls[0][0].where).toEqual({
      AND: [{ id: 10 }, { managerId: 1 }],
    });
    const options = db.attendanceRecord.findMany.mock.calls[0][0];
    expect(options.where).toEqual({ stationId: 10 });
    expect(options.orderBy).toEqual([{ clockInAt: 'asc' }, { id: 'asc' }]);
    expect(db.attendanceRecord.count).toHaveBeenCalledWith({
      where: options.where,
    });
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'RepeatableRead',
    });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(options.select.employee.select).toEqual({
      id: true,
      name: true,
      isActive: true,
    });
  });
  it('reads the newly assigned station after releasing previous ownership', async () => {
    stations[0].managerId = null;
    stations[1].managerId = 1;
    rows.push({ ...rows[0], id: 8, stationId: 11 });
    const response = await get(base.replace('/10/', '/11/'));
    expect(response.body.attendance.map((r: Row) => r.id)).toEqual([8]);
    expect(response.body.pagination).toEqual({
      page: 1,
      limit: 20,
      total: 1,
      totalPages: 1,
    });
  });
  it.each([
    [{ from: '2026-11-19T00:00:00Z', to: '2026-11-19T01:00:00Z' }, [4, 1]],
    [
      {
        from: '2026-11-19T10:00:00+02:00',
        to: '2026-11-19T14:00:00+02:00',
        employeeId: 3,
      },
      [4, 6],
    ],
    [{ from: '2026-11-20T00:00:00Z' }, [4]],
    [{ to: '2026-11-18T22:05:00Z' }, [4]],
    [{ employeeId: 999 }, []],
  ] as const)(
    'preserves overlap/offset/open/employee semantics: %j',
    async (query, ids) => {
      const response = await get(base, query);
      expect(response.status).toBe(200);
      expect(response.body.attendance.map((r: Row) => r.id)).toEqual(ids);
    },
  );
  it.each([
    { stationId: 20 },
    { employeeId: '1e3' },
    { employeeId: 2147483648 },
    { page: 0 },
    { page: 1000001 },
    { limit: 101 },
    { unknown: 1 },
    { from: '2026-11-19' },
    { from: '2026-11-19T10:00:00' },
    { from: '2026-02-30T00:00:00Z' },
    { from: '2026-11-19T00:00:00.0001Z' },
    { from: '2026-11-19T00:00:00Z', to: '2026-11-19T00:00:00Z' },
  ])('rejects invalid list filters: %j', async (query) => {
    expect((await get(base, query)).status).toBe(400);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it.each(['0', '-1', '1e3', '2147483648'])(
    'rejects malformed path station ID %s',
    async (id) => {
      expect((await get(base.replace('/10/', `/${id}/`))).status).toBe(400);
    },
  );
});

describe('CSV and PDF exports', () => {
  it.each(['csv', 'pdf'])(
    'exports all filtered rows in deterministic order: %s',
    async (format) => {
      // More than the JSON default page; tie timestamps test the ID tiebreaker.
      rows = Array.from({ length: 25 }, (_, i) => ({ ...rows[0], id: 25 - i }));
      rows.push({ ...rows[0], id: 101, stationId: 20 });
      rows.push({ ...rows[0], id: 102, employeeId: 4 });
      const filters = {
        employeeId: 3,
        from: '2026-11-19T00:00:00Z',
        to: '2026-11-19T01:00:00Z',
      };
      const listed: number[] = [];
      for (let page = 1; page <= 3; page++) {
        const response = await get(base, { ...filters, page, limit: 10 });
        listed.push(...response.body.attendance.map((row: Row) => row.id));
      }
      const response = await get(`${base}/export`, { ...filters, format });
      expect(response.status).toBe(200);
      expect(response.headers['content-disposition']).toBe(
        `attachment; filename="station-10-attendance.${format}"`,
      );
      expect(response.headers['cache-control']).toBe('no-store');
      const text =
        format === 'csv' ? response.text : pdfPages(response.body).join('\n');
      expect(response.headers['content-type']).toContain(
        format === 'csv' ? 'text/csv; charset=utf-8' : 'application/pdf',
      );
      const ids = [...text.matchAll(/Transferred Zoë (\d+)/g)].map((match) =>
        Number(match[1]),
      );
      expect(ids).toEqual(listed);
      const options = db.attendanceRecord.findMany.mock.calls.at(-1)![0];
      expect(options.where).toEqual(
        db.attendanceRecord.count.mock.calls[0][0].where,
      );
      expect(options.take).toBe(ATTENDANCE_EXPORT_LIMIT + 1);
      expect(options.skip).toBeUndefined();
    },
  );
  it('escapes CSV punctuation/newlines/formulas and leaves open clock-out blank', async () => {
    stations[0].name = ' =HYPERLINK("bad"),\nstation';
    employeeName = '\t@SUM(1,2)';
    const response = await get(`${base}/export`, {
      format: 'csv',
      from: '2026-11-20T00:00:00Z',
    });
    expect(response.status).toBe(200);
    expect(response.text).toContain('"\' =HYPERLINK(""bad""),\nstation"');
    expect(response.text).toContain('"\'\t@SUM(1,2) 4"');
    expect(response.text).toContain('"2026-11-18T20:00:00.000Z",""\r\n');
  });
  it.each(['csv', 'pdf'])('handles empty results: %s', async (format) => {
    const response = await get(`${base}/export`, { format, employeeId: 999 });
    expect(response.status).toBe(200);
    if (format === 'csv')
      expect(response.text).toBe(
        'Station,Employee,Clock-in (UTC),Clock-out (UTC)\r\n',
      );
    else {
      const pages = pdfPages(response.body);
      expect(pages).toHaveLength(1);
      expect(pages[0]).toContain('Historical Café');
      expect(pages[0]).toContain('No attendance records match the filters.');
    }
  });
  it.each(['csv', 'pdf'])(
    'rejects oversized selection before attachment: %s',
    async (format) => {
      db.attendanceRecord.findMany.mockResolvedValue(
        Array(ATTENDANCE_EXPORT_LIMIT + 1).fill({}),
      );
      const response = await get(`${base}/export`, { format });
      expect(response.status).toBe(422);
      expect(response.body.message).toContain(
        `exceeds ${ATTENDANCE_EXPORT_LIMIT} rows`,
      );
      expect(response.headers['content-disposition']).toBeUndefined();
    },
  );
  it('allows exactly the limit without truncation', async () => {
    rows = Array.from({ length: ATTENDANCE_EXPORT_LIMIT }, (_, i) => ({
      ...rows[0],
      id: i + 1,
    }));
    const response = await get(`${base}/export`, { format: 'csv' });
    expect(response.status).toBe(200);
    expect(response.text.match(/Transferred Zoë /g)).toHaveLength(
      ATTENDANCE_EXPORT_LIMIT,
    );
  });
  it.each([
    {},
    { format: 'xlsx' },
    { format: 'PDF' },
    { format: 'csv', page: 1 },
    { format: 'pdf', limit: 20 },
    { format: 'csv', stationId: 20 },
    { format: 'csv', employeeId: 0 },
    { format: 'pdf', from: '2026-11-19' },
    { format: 'pdf', from: '2026-11-20T00:00:00Z', to: '2026-11-19T00:00:00Z' },
  ])('rejects invalid export parameters: %j', async (query) => {
    expect((await get(`${base}/export`, query)).status).toBe(400);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it.each([
    'format=pdf&format=csv',
    'format=csv&employeeId=3&employeeId=4',
    'format=pdf&from=a&from=b',
  ])('rejects repeated export parameters: %s', async (query) => {
    expect((await get(`${base}/export?${query}`)).status).toBe(400);
  });
  it('creates a readable multi-page PDF with repeated headers and UTF-8 names', async () => {
    rows = Array.from({ length: 65 }, (_, i) => ({
      ...rows[0],
      id: i + 1,
      clockOutAt: null,
    }));
    employeeName = 'Zoë Ελληνικά Кириллица';
    const response = await get(`${base}/export`, {
      format: 'pdf',
      from: '2026-11-19T00:00:00+02:00',
      to: '2026-11-20T00:00:00+02:00',
    });
    expect(response.status).toBe(200);
    const pages = pdfPages(response.body);
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      for (const phrase of [
        'Historical Café',
        'Timezone: UTC',
        'Clock-in (UTC)',
        'Clock-out (UTC)',
        'Employee',
        'Open',
      ])
        expect(page).toContain(phrase);
    }
    const text = pages.join('\n');
    expect(text).toContain('2026-11-18T22:00:00.000Z');
    expect(text).toContain('2026-11-19T22:00:00.000Z');
    expect(
      [...text.matchAll(/Zoë Ελληνικά Кириллица\s+(\d+)/g)].map((m) =>
        Number(m[1]),
      ),
    ).toEqual(Array.from({ length: 65 }, (_, i) => i + 1));
  });
  it('fails clearly for unsupported PDF glyphs while CSV preserves the original text', async () => {
    employeeName = '漢字';
    const pdf = await get(`${base}/export`, { format: 'pdf' });
    expect(pdf.status).toBe(422);
    expect(pdf.body.message).toContain('use CSV export');
    expect((await get(`${base}/export`, { format: 'csv' })).text).toContain(
      '漢字',
    );
  });
  it('keeps Arabic names shaped and mixed-script station text and digits in order', async () => {
    stations[0].name = 'Historical Café - محطة بيروت';
    employeeName = 'أحمد علي';
    rows = [{ ...rows[0], id: 61 }];
    const response = await get(`${base}/export`, { format: 'pdf' });
    expect(response.status).toBe(200);
    const text = pdfPages(response.body).join('\n');
    expect(text).toContain('محطة بيروت');
    expect(text).toContain('أحمد علي');
    expect(text).toMatch(/\b61\b/);
    expect(text).not.toMatch(/\b16\b/);
  });
  it.each([
    '=SUM(1,2)',
    '+SUM(1,2)',
    '-SUM(1,2)',
    '@SUM(1,2)',
    '  =SUM(1,2)',
    '\r=SUM(1,2)',
    '\nname',
  ])('protects formula-like CSV text %j', async (name) => {
    employeeName = name;
    rows = [rows[0]];
    const response = await get(`${base}/export`, { format: 'csv' });
    expect(response.status).toBe(200);
    expect(response.text).toContain(`"'${name} 1"`);
  });
  it('wraps long names without losing text in the PDF', async () => {
    employeeName = 'Long employee name '.repeat(6).trim();
    rows = [rows[0]];
    const response = await get(`${base}/export`, { format: 'pdf' });
    expect(response.status).toBe(200);
    const text = pdfPages(response.body).join(' ').replace(/\s+/g, ' ');
    expect(text).toContain(`${employeeName} 1`);
  });
  it('rejects text too large for one PDF page instead of clipping rows', async () => {
    employeeName = 'Long name '.repeat(2000);
    const response = await get(`${base}/export`, { format: 'pdf' });
    expect(response.status).toBe(422);
    expect(response.body.message).toContain('too long for PDF');
    expect(response.headers['content-disposition']).toBeUndefined();
  });
});
