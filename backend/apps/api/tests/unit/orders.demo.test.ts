import {
  demoOrdersForStation,
  selectDemoOrders,
} from '../../src/modules/orders/orders.demo.js';

it('provides fresh deterministic records without mutable shared fixture state', () => {
  const first = demoOrdersForStation(10);
  const second = demoOrdersForStation(10);
  expect(first).toEqual(second);
  expect(first[0]).not.toBe(second[0]);
  Object.assign(first[0], { orderedAmountMinor: 999 });
  expect(demoOrdersForStation(10)[0].orderedAmountMinor).toBe(0);
});

it('selects an entire station without paginating or mutating the input for future analytics', () => {
  const mixed = [...demoOrdersForStation(20), ...demoOrdersForStation(10)];
  const before = JSON.stringify(mixed);
  const selected = selectDemoOrders(mixed, 10, {});
  expect(selected.map((order) => order.id)).toEqual([
    1008, 1007, 1006, 1005, 1004, 1003, 1002, 1001,
  ]);
  expect(JSON.stringify(mixed)).toBe(before);
  expect(selectDemoOrders(mixed, 999, {})).toEqual([]);
});

it('keeps station-specific numeric IDs unique and safe at the int32 station limit', () => {
  const first = demoOrdersForStation(2147483646);
  const second = demoOrdersForStation(2147483647);
  const ids = [...first, ...second].map((order) => order.id);
  expect(ids.every(Number.isSafeInteger)).toBe(true);
  expect(new Set(ids).size).toBe(16);
});
