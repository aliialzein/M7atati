import { Decimal } from '@prisma/client/runtime/client';
import { HttpError } from '../../types/http-error.js';
import type { Currency } from '../fuel-prices/fuel-prices.validation.js';

const Exact = Decimal.clone({ precision: 64, rounding: Decimal.ROUND_HALF_UP });
export const currencyDecimals = (currency: Currency) =>
  currency === 'USD' ? 2 : 0;
const maxMinor = new Exact('2147483647');
const maxQuantity = new Exact('999999999.999');
export function moneyMinor(value: string, currency: Currency): number {
  const amount = new Exact(value);
  if (
    !amount.isFinite() ||
    amount.lte(0) ||
    amount.decimalPlaces() > currencyDecimals(currency)
  )
    throw new HttpError('Invalid monetary amount or currency precision', 400);
  const minor = amount.mul(currency === 'USD' ? 100 : 1);
  if (minor.gt(maxMinor))
    throw new HttpError('Monetary amount exceeds storage limits', 400);
  return minor.toNumber();
}
export function moneyString(minor: number, currency: Currency) {
  return new Exact(minor)
    .div(currency === 'USD' ? 100 : 1)
    .toFixed(currencyDecimals(currency));
}
export function calculateQuote(
  unitPriceMinor: number,
  currency: Currency,
  mode: 'AMOUNT' | 'LITERS',
  value: string,
) {
  if (
    !Number.isInteger(unitPriceMinor) ||
    unitPriceMinor <= 0 ||
    unitPriceMinor > 2147483647
  )
    throw new HttpError('Invalid selling price', 409);
  let quantity: Decimal;
  let budget: number | undefined;
  if (mode === 'AMOUNT') {
    budget = moneyMinor(value, currency);
    quantity = new Exact(budget)
      .div(unitPriceMinor)
      .toDecimalPlaces(3, Decimal.ROUND_HALF_UP);
    // HALF_UP may round quantity upward. Reduce one 0.001 L increment when the
    // rounded charge would exceed the budget; never round a budget upward.
    if (
      quantity
        .mul(unitPriceMinor)
        .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
        .gt(budget)
    )
      quantity = quantity.minus('0.001');
  } else {
    quantity = new Exact(value);
    if (!quantity.isFinite() || quantity.decimalPlaces() > 3)
      throw new HttpError(
        'Quantity must have at most three decimal places',
        400,
      );
  }
  if (quantity.lte(0) || quantity.gt(maxQuantity))
    throw new HttpError('Quantity is outside storage limits', 400);
  const total = quantity
    .mul(unitPriceMinor)
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  if (
    total.lte(0) ||
    total.gt(maxMinor) ||
    (budget !== undefined && total.gt(budget))
  )
    throw new HttpError('Order total is outside storage limits or budget', 400);
  return { quantity: quantity.toFixed(3), totalMinor: total.toNumber() };
}
