// Explicit test/demo data only. Never imported by application startup or seeds.
// Actual attendance is authored independently, not inferred from planned shifts.
export function workRecordFixtures(ids: {
  employeeA: number;
  employeeB: number;
  stationA: number;
  stationB: number;
}) {
  const a = { employeeId: ids.employeeA, stationId: ids.stationA };
  const b = { employeeId: ids.employeeB, stationId: ids.stationB };
  return {
    shifts: [
      {
        ...a,
        startsAt: new Date('2026-11-18T22:00:00Z'),
        endsAt: new Date('2026-11-19T06:00:00Z'),
      },
      {
        ...a,
        startsAt: new Date('2026-11-19T06:00:00Z'),
        endsAt: new Date('2026-11-19T08:00:00Z'),
      },
      {
        ...b,
        startsAt: new Date('2026-11-19T08:00:00Z'),
        endsAt: new Date('2026-11-19T16:00:00Z'),
      },
      {
        ...a,
        startsAt: new Date('2026-11-19T08:00:00Z'),
        endsAt: new Date('2026-11-19T10:00:00Z'),
      },
      {
        ...b,
        startsAt: new Date('2026-11-19T12:00:00Z'),
        endsAt: new Date('2026-11-19T20:00:00Z'),
      },
    ],
    attendance: [
      {
        ...a,
        clockInAt: new Date('2026-11-18T22:05:00Z'),
        clockOutAt: new Date('2026-11-19T06:05:00Z'),
      },
      {
        ...a,
        clockInAt: new Date('2026-11-19T06:10:00Z'),
        clockOutAt: new Date('2026-11-19T08:00:00Z'),
      },
      {
        ...b,
        clockInAt: new Date('2026-11-19T08:00:00Z'),
        clockOutAt: new Date('2026-11-19T16:00:00Z'),
      },
      { ...a, clockInAt: new Date('2026-11-18T20:00:00Z'), clockOutAt: null },
      { ...b, clockInAt: new Date('2026-11-19T12:00:00Z'), clockOutAt: null },
      {
        ...a,
        clockInAt: new Date('2026-11-19T09:00:00Z'),
        clockOutAt: new Date('2026-11-19T09:00:00Z'),
      },
    ],
  };
}
