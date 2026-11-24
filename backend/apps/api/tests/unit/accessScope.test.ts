import { stationScope } from '../../src/utils/accessScope.js';

describe('reusable station scope', () => {
  it('gives ADMIN global scope and MANAGER relationship-based scope', () => {
    expect(stationScope({ id: 1, role: 'ADMIN', stationId: null })).toEqual({});
    expect(stationScope({ id: 2, role: 'MANAGER', stationId: 99 })).toEqual({
      managerId: 2,
    });
  });

  it('limits EMPLOYEE to their assigned station, or no stations when unassigned', () => {
    expect(stationScope({ id: 3, role: 'EMPLOYEE', stationId: 10 })).toEqual({
      id: 10,
    });
    expect(stationScope({ id: 3, role: 'EMPLOYEE', stationId: null })).toEqual({
      id: { in: [] },
    });
  });

  it.each(['CUSTOMER', 'HR', 'SECURITY'])(
    'does not invent station-management scope for %s',
    (role) => {
      expect(() => stationScope({ id: 4, role, stationId: 10 })).toThrow(
        'No authorized station scope',
      );
    },
  );
});
