import {
  calculateQuote,
  moneyMinor,
  moneyString,
} from '../../src/modules/orders/orders.pricing.js';
import {
  createOrderSchema,
  quoteInputSchema,
} from '../../src/modules/orders/orders.validation.js';

it.each([
  [500, 'USD', 'LITERS', '0.001', '0.001', 1],
  [500, 'USD', 'LITERS', '0.003', '0.003', 2],
  [501, 'LBP', 'LITERS', '0.500', '0.500', 251],
  [199, 'USD', 'AMOUNT', '10.00', '5.025', 1000],
  [9999, 'LBP', 'AMOUNT', '17', '0.001', 10],
  [100, 'USD', 'LITERS', '1.250', '1.250', 125],
] as const)(
  'calculates %s %s %s %s precisely',
  (price, currency, mode, value, quantity, totalMinor) => {
    expect(calculateQuote(price, currency, mode, value)).toEqual({
      quantity,
      totalMinor,
    });
  },
);

it.each([
  [1500, 'USD', 'AMOUNT', '0.01'],
  [100, 'USD', 'LITERS', '0'],
  [100, 'USD', 'LITERS', '1.0001'],
  [100, 'USD', 'LITERS', '1000000000'],
  [2147483647, 'USD', 'LITERS', '2'],
  [0, 'USD', 'LITERS', '1'],
  [-1, 'LBP', 'LITERS', '1'],
  [2147483648, 'LBP', 'LITERS', '1'],
  [100, 'USD', 'AMOUNT', '1.001'],
  [100, 'LBP', 'AMOUNT', '1.5'],
  [100, 'USD', 'AMOUNT', '21474836.48'],
] as const)(
  'rejects invalid or unrepresentable quote %j %s %s %s',
  (price, currency, mode, value) => {
    expect(() => calculateQuote(price, currency, mode, value)).toThrow();
  },
);

it('never exceeds amount budgets across currencies, rounding boundaries and high prices', () => {
  for (const currency of ['USD', 'LBP'] as const) {
    for (const price of [1, 99, 1500, 9999, 2147483647]) {
      for (const budget of [10000, 100000, 2147483647]) {
        if (budget * 1000 < price || budget / price > 999999999.999) continue;
        const value = moneyString(budget, currency);
        const quote = calculateQuote(price, currency, 'AMOUNT', value);
        expect(quote.totalMinor).toBeLessThanOrEqual(budget);
        expect(quote.totalMinor).toBeGreaterThan(0);
        expect(quote.quantity).toMatch(/^\d+\.\d{3}$/);
      }
    }
  }
});

it('keeps USD cents and whole LBP independent without conversion', () => {
  expect(moneyMinor('1.25', 'USD')).toBe(125);
  expect(moneyMinor('125', 'LBP')).toBe(125);
  expect(moneyString(125, 'USD')).toBe('1.25');
  expect(moneyString(125, 'LBP')).toBe('125');
});

const quote = {
  stationId: 10,
  fuelTypeId: 1,
  currency: 'USD',
  fulfillmentType: 'IN_STATION',
  inputMode: 'LITERS',
  value: '1.000',
};
it.each([
  'unitPrice',
  'unitPriceMinor',
  'total',
  'totalMinor',
  'pumpId',
  'userId',
  'status',
  'sellingPriceId',
])('rejects client-authored %s in quotations and creations', (field) => {
  expect(quoteInputSchema.safeParse({ ...quote, [field]: 1 }).success).toBe(
    false,
  );
  expect(
    createOrderSchema.safeParse({
      quoteId: '1c88705d-41c4-417b-b9fd-62ecf4e94db7',
      idempotencyKey: 'd8ca92df-f78b-4e5a-ac62-6444d1ff8b62',
      [field]: 1,
    }).success,
  ).toBe(false);
});
it.each(['1e3', '-1', 'NaN', 'Infinity', '01', '.5', ' 1', 1])(
  'rejects noncanonical decimal input %j',
  (value) => {
    expect(quoteInputSchema.safeParse({ ...quote, value }).success).toBe(false);
  },
);
